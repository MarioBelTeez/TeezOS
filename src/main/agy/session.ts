import { execFile, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { UiEvent } from "../claude/events.ts";
import type { ApprovalDecision } from "../claude/service.ts";
import type { AgentSession, SlashCommandInfo } from "../agents/registry.ts";
import { AgyEventConverter } from "./events.ts";

/**
 * One Antigravity chat. Each message is its own `agy` run, continued with
 * `--conversation <id>` from the second one on, the prompt written to stdin as
 * stream-json (`{"event":"user","message":{"content":…}}`) so its length and
 * characters never meet a command line.
 *
 * Headless agy cannot ask for permission mid-run, so there are no approval
 * cards: the chat's mode decides up front what it may do. Stop kills the run;
 * the conversation id survives, so the next message carries on.
 */

export type ChildLike = {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	readonly pid?: number | undefined;
	on(event: "exit" | "close", listener: (code: number | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	kill(): unknown;
};

export type SpawnFn = (file: string, args: readonly string[], options: { readonly cwd: string }) => ChildLike;

export type AgySessionDeps = {
	readonly agyPath: string;
	readonly cwd: string;
	readonly model: string;
	readonly permission: string;
	readonly effort: string;
	/**
	 * A one-off /btw run: no slash command or skill expansion (`--disable-slash-commands`),
	 * so text from the hand-over summary can never invoke one. agy (checked against
	 * `agy --help`) has no flag that turns off MCP servers or tools for one run, and no
	 * way to delete a conversation: plan mode is what keeps a side question read-only.
	 */
	readonly sideQuestion?: boolean;
	readonly resume?: string;
	readonly onEvent: (event: UiEvent) => void;
	readonly spawn?: SpawnFn;
	/** Ends the process and anything it started. */
	readonly killTree?: (child: ChildLike) => void;
	readonly now?: () => number;
};

export const defaultSpawn: SpawnFn = (file, args, options) =>
	nodeSpawn(file, [...args], {
		cwd: options.cwd,
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
		// Its own process group on Linux, so Stop can take its helpers down too.
		detached: process.platform !== "win32",
	});

export function defaultKillTree(child: ChildLike): void {
	if (!child.pid) {
		child.kill();
		return;
	}
	if (process.platform === "win32") {
		// agy starts helpers of its own; /T takes the whole tree down.
		execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill();
	}
}

export function permissionFlags(permission: string): string[] {
	switch (permission) {
		case "plan":
			return ["--mode", "plan"];
		case "accept-edits":
			return ["--mode", "accept-edits"];
		case "full-auto":
			return ["--dangerously-skip-permissions"];
		default:
			return [];
	}
}

export class AgySession implements AgentSession {
	readonly #deps: AgySessionDeps;
	#conversationId: string;
	#model: string;
	#permission: string;
	#effort: string;
	#child: ChildLike | null = null;
	#queue: string[] = [];
	#stopped = false;
	#startedAt = 0;
	#disposed = false;

	constructor(deps: AgySessionDeps) {
		this.#deps = deps;
		this.#conversationId = deps.resume ?? "";
		this.#model = deps.model;
		this.#permission = deps.permission;
		this.#effort = deps.effort;
	}

	get conversationId(): string {
		return this.#conversationId;
	}

	/** The conversation id, under the name every agent session shares. */
	get sessionId(): string {
		return this.#conversationId;
	}

	send(text: string, images: readonly unknown[] = []): void {
		if (this.#disposed) return;
		// Antigravity's headless input takes text only; say so rather than drop them silently.
		if (images.length > 0) text = `${text}\n\n[${images.length} pasted image(s) left out: Antigravity's CLI accepts text only]`;
		if (this.#child) {
			this.#queue.push(text);
			return;
		}
		this.#run(text);
	}

	async stop(): Promise<void> {
		this.#queue = [];
		if (!this.#child) return;
		this.#stopped = true;
		(this.#deps.killTree ?? defaultKillTree)(this.#child);
	}

	/** Nothing to settle: a headless run never asks. */
	respondToApproval(_id: string, _decision: ApprovalDecision): void {}

	async setModel(model: string): Promise<void> {
		this.#model = model;
	}

	async setPermissionMode(mode: string): Promise<void> {
		this.#permission = mode;
	}

	/** Each turn is its own agy run, so the next one simply uses it. */
	async setEffort(effort: string): Promise<void> {
		this.#effort = effort;
	}

	/** Headless agy reports no slash commands, and a run takes none. */
	async commands(): Promise<SlashCommandInfo[]> {
		return [];
	}

	dispose(): void {
		this.#disposed = true;
		void this.stop();
	}

	args(): string[] {
		return [
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--add-dir",
			this.#deps.cwd,
			"--effort",
			this.#effort || "medium",
			...(this.#model ? ["--model", this.#model] : []),
			...(this.#conversationId ? ["--conversation", this.#conversationId] : []),
			...permissionFlags(this.#permission),
			...(this.#deps.sideQuestion ? ["--disable-slash-commands"] : []),
			// The prompt comes on stdin; an empty -p= keeps print mode on.
			"-p=",
		];
	}

	#run(text: string): void {
		const now = this.#deps.now ?? Date.now;
		this.#stopped = false;
		this.#startedAt = now();
		const converter = new AgyEventConverter({ model: this.#model });
		const stderr: string[] = [];
		let sawResult = false;

		let child: ChildLike;
		try {
			child = (this.#deps.spawn ?? defaultSpawn)(this.#deps.agyPath, this.args(), { cwd: this.#deps.cwd });
		} catch (error) {
			this.#emit({ kind: "run-error", sessionId: this.#conversationId, reason: "agy-not-found", message: String(error) });
			return;
		}
		this.#child = child;

		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		lines.on("line", (line) => {
			if (!line.trim()) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return;
			}
			for (const event of converter.push(parsed)) {
				if (event.kind === "turn-end" || (event.kind === "run-error" && event.reason === "agy-error")) sawResult = true;
				this.#emit(event);
			}
			if (converter.conversationId) this.#conversationId = converter.conversationId;
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			for (const part of String(chunk).split(/\r?\n/)) if (part.trim()) stderr.push(part.trim());
			if (stderr.length > 20) stderr.splice(0, stderr.length - 20);
		});

		let finished = false;
		const finish = (code: number | null, spawnError?: Error): void => {
			if (finished) return;
			finished = true;
			lines.close();
			this.#child = null;
			if (this.#stopped) {
				this.#emit({ kind: "turn-cancelled", sessionId: this.#conversationId, durationMs: now() - this.#startedAt });
			} else if (!sawResult) {
				this.#emit({
					kind: "run-error",
					sessionId: this.#conversationId,
					reason: spawnError ? "agy-not-found" : "agy-exit",
					message: [spawnError?.message ?? `Antigravity exited with code ${code ?? "?"}.`, ...stderr].join("\n"),
				});
			}
			const next = this.#queue.shift();
			if (next !== undefined && !this.#disposed) this.#run(next);
		};
		// "close", not "exit": exit can fire while stdout still holds the final
		// result line; close waits until the streams are drained.
		child.on("close", (code) => finish(code));
		child.on("error", (error) => finish(null, error));

		child.stdin.on("error", () => undefined);
		child.stdin.end(`${JSON.stringify({ event: "user", message: { content: text } })}\n`);
	}

	#emit(event: UiEvent): void {
		if (!this.#disposed || event.kind === "turn-cancelled") this.#deps.onEvent(event);
	}
}
