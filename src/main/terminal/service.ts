import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { ShellChoice } from "../../shared/modules.ts";
import { autoShell, shellProgram } from "./shell.ts";
import { remoteControlCommand } from "./remote.ts";

/**
 * Real shells, one pseudo-terminal per tab.
 *
 * Output is batched and sent at most once per frame: a build or `npm install`
 * prints thousands of tiny chunks, and one IPC message per chunk would stall
 * the window. Profiles name what may be started — a shell, an SSH session to
 * the server, a Claude login — so the window never passes a program path.
 */

/** "claude-remote": Remote Control server for new phone sessions; "claude-resume-remote": one chat handed over to the phone. */
export type TerminalProfile = "shell" | "ssh-pve" | "ssh-ct" | "claude-login" | "claude-setup-token" | "agy" | "claude-remote" | "claude-resume-remote";

export type TerminalInfo = {
	readonly id: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly profile: TerminalProfile;
};

type Sink = {
	readonly data: (id: string, data: string) => void;
	readonly exit: (id: string, exitCode: number) => void;
};

type Live = {
	readonly info: TerminalInfo;
	readonly process: pty.IPty;
	buffer: string;
	timer: NodeJS.Timeout | null;
};

const FLUSH_MS = 16;
const MAX_BUFFER = 256 * 1024;

/** PowerShell 7 when installed, Windows PowerShell otherwise; $SHELL on Linux. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
	return autoShell(env, platform, existsSync);
}

function program(profile: TerminalProfile, vmid?: number, choice: ShellChoice = "auto", sessionId?: string): { file: string; args: readonly string[]; title: string } {
	const shell = defaultShell();
	const isPowerShell = /pwsh|powershell/i.test(shell);
	switch (profile) {
		case "ssh-pve":
			return { file: process.platform === "win32" ? "ssh.exe" : "ssh", args: ["pve"], title: "ssh pve" };
		case "ssh-ct":
			// A shell inside a container, through the host.
			return {
				file: process.platform === "win32" ? "ssh.exe" : "ssh",
				args: ["-t", "pve", "pct", "enter", String(vmid ?? 0)],
				title: `CT ${vmid ?? "?"}`,
			};
		case "claude-login":
			return isPowerShell
				? { file: shell, args: ["-NoLogo", "-NoExit", "-Command", "claude"], title: "claude" }
				: { file: shell, args: ["-lc", "claude; exec $SHELL"], title: "claude" };
		case "claude-setup-token":
			// Prints a long-lived subscription token for headless use (the runner).
			return isPowerShell
				? { file: shell, args: ["-NoLogo", "-NoExit", "-Command", "claude setup-token"], title: "claude setup-token" }
				: { file: shell, args: ["-lc", "claude setup-token; exec $SHELL"], title: "claude setup-token" };
		case "claude-remote":
		case "claude-resume-remote": {
			// remoteControlCommand refuses anything that is not a session id.
			const command = remoteControlCommand(profile === "claude-resume-remote" ? (sessionId ?? "") : undefined);
			const title = profile === "claude-remote" ? "phone (Remote Control)" : "chat on phone";
			return isPowerShell
				? { file: shell, args: ["-NoLogo", "-NoExit", "-Command", command], title }
				: { file: shell, args: ["-lc", command + "; exec $SHELL"], title };
		}
		case "agy":
			return isPowerShell
				? { file: shell, args: ["-NoLogo", "-NoExit", "-Command", "agy"], title: "agy" }
				: { file: shell, args: ["-lc", "agy; exec $SHELL"], title: "agy" };
		default:
			// A plain shell tab follows Settings → Terminal; the profiles above need PowerShell or a POSIX shell, so they keep the automatic one.
			return shellProgram(choice, process.env, process.platform, existsSync);
	}
}

export class TerminalService {
	readonly #terminals = new Map<string, Live>();

	constructor(readonly sink: Sink) {}

	create(options: {
		readonly workspaceId: string;
		readonly cwd: string;
		readonly cols: number;
		readonly rows: number;
		readonly profile: TerminalProfile;
		readonly vmid?: number;
		/** Which shell a "shell" tab runs (Settings → Terminal). */
		readonly shell?: ShellChoice;
		/** The Claude session a "claude-resume-remote" tab resumes. */
		readonly sessionId?: string;
	}): TerminalInfo {
		const { file, args, title } = program(options.profile, options.vmid, options.shell, options.sessionId);
		const id = randomUUID();
		const child = pty.spawn(file, [...args], {
			name: "xterm-256color",
			cols: Math.max(2, Math.floor(options.cols)),
			rows: Math.max(2, Math.floor(options.rows)),
			cwd: options.cwd,
			env: { ...process.env, TERM_PROGRAM: "TeezOS", COLORTERM: "truecolor" } as Record<string, string>,
			useConpty: true,
		});
		const info: TerminalInfo = { id, workspaceId: options.workspaceId, title, profile: options.profile };
		const live: Live = { info, process: child, buffer: "", timer: null };
		this.#terminals.set(id, live);

		child.onData((data) => {
			live.buffer += data;
			if (live.buffer.length > MAX_BUFFER) this.#flush(live);
			else live.timer ??= setTimeout(() => this.#flush(live), FLUSH_MS);
		});
		child.onExit(({ exitCode }) => {
			this.#flush(live);
			this.#terminals.delete(id);
			this.sink.exit(id, exitCode);
		});
		return info;
	}

	#flush(live: Live): void {
		if (live.timer) clearTimeout(live.timer);
		live.timer = null;
		if (!live.buffer) return;
		const data = live.buffer;
		live.buffer = "";
		this.sink.data(live.info.id, data);
	}

	write(id: string, data: string): void {
		this.#terminals.get(id)?.process.write(data);
	}

	resize(id: string, cols: number, rows: number): void {
		const live = this.#terminals.get(id);
		if (!live) return;
		try {
			live.process.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
		} catch {
			// resizing a process that is exiting can throw; nothing to do
		}
	}

	kill(id: string): void {
		const live = this.#terminals.get(id);
		if (!live) return;
		this.#terminals.delete(id);
		if (live.timer) clearTimeout(live.timer);
		try {
			live.process.kill();
		} catch {
			// already gone
		}
	}

	list(): TerminalInfo[] {
		return [...this.#terminals.values()].map((live) => live.info);
	}

	killWorkspace(workspaceId: string): void {
		for (const live of [...this.#terminals.values()]) {
			if (live.info.workspaceId === workspaceId) this.kill(live.info.id);
		}
	}

	disposeAll(): void {
		for (const id of [...this.#terminals.keys()]) this.kill(id);
	}
}
