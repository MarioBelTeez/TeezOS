import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { shell } from "electron";
import { listModels, resolveAgy } from "../agy/locate.ts";
import { resolveClaudeBinary } from "../claude/locator.ts";
import { resolveCodex } from "../codex/locate.ts";
import { codexStatus, probeCodex, readCodexVersion } from "../codex/status.ts";

function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

function locateDeps() {
	return {
		platform: process.platform,
		env: process.env,
		home: homedir(),
		pathEntries: (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean),
		isFile,
	};
}

function locateClaude(): string | null {
	const d = locateDeps();
	const res = resolveClaudeBinary({
		platform: d.platform,
		home: d.home,
		pathEntries: d.pathEntries,
		isFile: d.isFile,
	});
	return res.ok ? res.path : null;
}

function locateCodex(): string | null {
	return resolveCodex(locateDeps());
}

function locateAgy(): string | null {
	return resolveAgy(locateDeps());
}

export type ProviderId = "claude" | "codex" | "agy";

export type ProviderState = {
	readonly id: ProviderId;
	readonly installed: boolean;
	readonly loggedIn: boolean;
	readonly detail?: string;
};

export type LoginResult = {
	readonly ok: boolean;
	readonly error?: string;
	readonly url?: string;
};

export type InstallResult = {
	readonly ok: boolean;
	readonly error?: string;
};

const HTTPS_URL = /https:\/\/[^\s"'<>]+/i;
const LOGIN_TIMEOUT_MS = 3 * 60_000;
const INSTALL_TIMEOUT_MS = 3 * 60_000;

/** Extracts the first HTTPS OAuth URL printed by a CLI login command. */
export function extractAuthUrl(text: string): string | null {
	const match = HTTPS_URL.exec(text);
	return match ? match[0].replace(/[),.;]+$/, "") : null;
}

/** Parses `claude auth status` JSON output safely. */
export function parseClaudeAuthStatus(output: string): { readonly loggedIn: boolean; readonly detail?: string } {
	try {
		const parsed = JSON.parse(output) as { loggedIn?: unknown; subscriptionType?: unknown; authMethod?: unknown };
		const loggedIn = parsed.loggedIn === true;
		const sub = typeof parsed.subscriptionType === "string" && parsed.subscriptionType ? parsed.subscriptionType : undefined;
		return sub ? { loggedIn, detail: sub } : { loggedIn };
	} catch {
		return { loggedIn: false };
	}
}

async function checkClaude(): Promise<ProviderState> {
	const claudePath = locateClaude();
	if (!claudePath) return { id: "claude", installed: false, loggedIn: false };
	return new Promise((resolve) => {
		execFile(claudePath, ["auth", "status"], { windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) => {
			if (error && !stdout) {
				resolve({ id: "claude", installed: true, loggedIn: false });
				return;
			}
			const parsed = parseClaudeAuthStatus(String(stdout || stderr));
			resolve({
				id: "claude",
				installed: true,
				loggedIn: parsed.loggedIn,
				...(parsed.detail ? { detail: parsed.detail } : {}),
			});
		});
	});
}

async function checkCodex(): Promise<ProviderState> {
	const status = await codexStatus({
		locate: locateCodex,
		version: readCodexVersion,
		probe: probeCodex,
	});
	if (status.available) return { id: "codex", installed: true, loggedIn: true };
	if (status.reason === "codex-not-found") return { id: "codex", installed: false, loggedIn: false };
	if (status.reason === "codex-unsupported") {
		return { id: "codex", installed: true, loggedIn: false, detail: `Unsupported version${status.version ? ` (${status.version})` : ""}` };
	}
	return { id: "codex", installed: true, loggedIn: false };
}

async function checkAgy(): Promise<ProviderState> {
	const agyPath = locateAgy();
	if (!agyPath) return { id: "agy", installed: false, loggedIn: false };
	const models = await listModels(agyPath);
	return { id: "agy", installed: true, loggedIn: models.length > 0 };
}

export async function readProviderStatuses(): Promise<ProviderState[]> {
	return Promise.all([checkClaude(), checkCodex(), checkAgy()]);
}

function runBrowserAuth(command: string, args: readonly string[]): Promise<LoginResult> {
	return new Promise((resolve) => {
		let settled = false;
		let openedUrl: string | null = null;
		let outputTail = "";
		const child = spawn(command, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

		const finish = (result: LoginResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// ignore
			}
			finish({
				ok: false,
				error: "Sign-in timed out after 3 minutes. Try again or use the terminal.",
				...(openedUrl ? { url: openedUrl } : {}),
			});
		}, LOGIN_TIMEOUT_MS);

		const onData = (chunk: Buffer | string): void => {
			const text = String(chunk);
			outputTail = (outputTail + text).slice(-2000);
			if (!openedUrl) {
				const url = extractAuthUrl(text);
				if (url) {
					openedUrl = url;
					void shell.openExternal(url);
				}
			}
		};

		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (error) => finish({ ok: false, error: error.message }));
		child.on("close", (code) => {
			if (code === 0) finish({ ok: true, ...(openedUrl ? { url: openedUrl } : {}) });
			else {
				finish({
					ok: false,
					error: outputTail.trim().split(/\r?\n/).slice(-3).join(" ") || `Sign-in exited with code ${code ?? "?"}.`,
					...(openedUrl ? { url: openedUrl } : {}),
				});
			}
		});
	});
}

export async function loginProvider(id: ProviderId): Promise<LoginResult> {
	if (id === "claude") {
		const claudePath = locateClaude();
		if (!claudePath) return { ok: false, error: "Claude Code is not installed yet." };
		return runBrowserAuth(claudePath, ["auth", "login"]);
	}
	if (id === "codex") {
		const codexPath = locateCodex();
		if (!codexPath) return { ok: false, error: "Codex is not installed yet." };
		return runBrowserAuth(codexPath, ["login"]);
	}
	const agyPath = locateAgy();
	if (!agyPath) return { ok: false, error: "Antigravity is not installed yet." };
	return runBrowserAuth(agyPath, ["models"]);
}

export async function installProvider(id: ProviderId): Promise<InstallResult> {
	if (id === "agy") {
		await shell.openExternal("https://antigravity.google");
		return { ok: true };
	}
	const pkg = id === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex@0.166";
	const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
	return new Promise((resolve) => {
		execFile(
			npmCmd,
			["install", "-g", pkg],
			{ windowsHide: true, timeout: INSTALL_TIMEOUT_MS, shell: process.platform === "win32" },
			(error, _stdout, stderr) => {
				if (!error) {
					resolve({ ok: true });
					return;
				}
				const msg = String(stderr || error.message);
				if (/not recognized|ENOENT/i.test(msg)) {
					void shell.openExternal("https://nodejs.org");
					resolve({ ok: false, error: "Node.js is required to install this CLI. Opened nodejs.org in your browser." });
					return;
				}
				resolve({ ok: false, error: msg.trim().split(/\r?\n/).slice(-3).join(" ") || "Install failed." });
			},
		);
	});
}
