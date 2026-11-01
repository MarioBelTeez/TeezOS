import { execFile } from "node:child_process";
import { defaultKillTree, defaultSpawn, type SpawnFn } from "../agy/session.ts";
import { isSupportedCodex, parseCodexVersion } from "./locate.ts";
import { CodexRpc } from "./rpc.ts";

/**
 * Whether Codex can run a chat: installed, a protocol version TeezOS speaks,
 * and logged in (asked of Codex itself: TeezOS never reads its auth file).
 */

export type CodexModel = { readonly id: string; readonly label: string };
export type CodexReason = "codex-not-found" | "codex-logged-out" | "codex-unsupported";
export type CodexStatus =
	| { readonly available: true; readonly models: readonly CodexModel[] }
	| { readonly available: false; readonly reason: CodexReason; readonly models: readonly []; readonly version?: string };

export async function codexStatus(deps: {
	readonly locate: () => string | null;
	readonly version: (path: string) => Promise<string | null>;
	readonly probe: (path: string) => Promise<{ readonly loggedIn: boolean; readonly models: readonly CodexModel[] }>;
}): Promise<CodexStatus> {
	const codexPath = deps.locate();
	if (!codexPath) return { available: false, reason: "codex-not-found", models: [] };
	const version = await deps.version(codexPath);
	if (!version || !isSupportedCodex(version)) return { available: false, reason: "codex-unsupported", models: [], ...(version ? { version } : {}) };
	const probe = await deps.probe(codexPath);
	if (!probe.loggedIn) return { available: false, reason: "codex-logged-out", models: [] };
	return { available: true, models: probe.models };
}

/** `model/list`'s result → the visible models, the account's default first. */
export function codexModelsOf(result: unknown): CodexModel[] {
	const data = typeof result === "object" && result !== null ? (result as { data?: unknown }).data : null;
	if (!Array.isArray(data)) return [];
	const models: { model: CodexModel; isDefault: boolean }[] = [];
	for (const entry of data) {
		if (typeof entry !== "object" || entry === null) continue;
		const m = entry as Record<string, unknown>;
		if (typeof m["id"] !== "string" || !m["id"] || m["hidden"] === true) continue;
		const label = typeof m["displayName"] === "string" && m["displayName"] ? m["displayName"] : m["id"];
		models.push({ model: { id: m["id"], label: label.trim() }, isDefault: m["isDefault"] === true });
	}
	return [...models.filter((m) => m.isDefault), ...models.filter((m) => !m.isDefault)].map((m) => m.model);
}

/** `codex --version`, parsed; null when it can't be read in time. */
export function readCodexVersion(codexPath: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(codexPath, ["--version"], { windowsHide: true, timeout: 10_000 }, (error, stdout) => resolve(error ? null : parseCodexVersion(String(stdout))));
	});
}

/** Starts app-server just long enough to ask whether it is logged in and which models it offers. */
export async function probeCodex(codexPath: string, spawn: SpawnFn = defaultSpawn): Promise<{ loggedIn: boolean; models: CodexModel[] }> {
	const child = spawn(codexPath, ["app-server"], { cwd: process.cwd() });
	const rpc = new CodexRpc(child, { onNotification: () => undefined, onServerRequest: async () => ({ decision: "decline" }), onExit: () => undefined });
	try {
		await rpc.request("initialize", { clientInfo: { name: "teezos", title: "TeezOS", version: "status" }, capabilities: null }, 20_000);
		rpc.notify("initialized", {});
		const account = await rpc.request<{ account?: unknown }>("account/read", {}, 20_000);
		const loggedIn = typeof account === "object" && account !== null && account.account != null;
		const models = loggedIn ? codexModelsOf(await rpc.request("model/list", {}, 20_000)) : [];
		return { loggedIn, models };
	} catch {
		return { loggedIn: false, models: [] };
	} finally {
		rpc.close();
		defaultKillTree(child);
	}
}
