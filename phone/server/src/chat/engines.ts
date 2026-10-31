import { createInterface } from "node:readline";
import { EventConverter, type UiEvent } from "../../../../src/main/claude/events.ts";
import { AgySession, type ChildLike } from "../../../../src/main/agy/session.ts";
import { stopChild, type JobUser } from "./job-user.ts";

/**
 * One turn of a phone chat on either engine, run as the job user in the
 * agent's vault clone. A turn reports its events, then settles with the
 * conversation id to continue from; `stop` ends it early.
 */

export type Turn = { readonly done: Promise<string>; stop(): void };

export type TurnRequest = {
	readonly jobUser: JobUser;
	readonly cwd: string;
	readonly effort: string;
	readonly conversationId: string;
	readonly prompt: string;
	readonly onEvent: (event: UiEvent) => void;
};

/** Claude, read-only: the runner's read tools, nothing that writes, fetches or runs commands. */
const CLAUDE_READ_TOOLS = "Read,Glob,Grep,LS";
const STDERR_LINES = 20;

/** Settles once the child has closed and its owner has handled the close. */
function closed(child: ChildLike): Promise<void> {
	return new Promise((resolve) => {
		const settle = (): void => void setImmediate(resolve);
		child.on("close", settle);
		child.on("error", settle);
	});
}

/** Antigravity through the desktop's AgySession, its process started as the job user. */
export function runAgyTurn(request: TurnRequest & { readonly agyPath: string }): Turn {
	const spawned: { ended?: Promise<void> } = {};
	const session = new AgySession({
		agyPath: request.agyPath,
		cwd: request.cwd,
		model: "",
		// No mode flag: the read-only allow/deny rules written before the turn decide.
		permission: "",
		effort: request.effort,
		resume: request.conversationId,
		onEvent: request.onEvent,
		spawn: (file, args, options) => {
			const child = request.jobUser.spawn(options.cwd, file, args);
			spawned.ended = closed(child);
			return child;
		},
		// sudo passes SIGTERM on to agy, as the runner relies on; a survivor is killed 10 s later.
		killTree: (child) => stopChild(child, spawned.ended ?? Promise.resolve(), () => void request.jobUser.killSurvivors()),
	});
	session.send(request.prompt);
	// A spawn that threw has already reported itself as a run error.
	const done = (spawned.ended ?? Promise.resolve()).then(() => session.conversationId);
	return { done, stop: () => void session.stop() };
}

export function claudeArgs(effort: string, conversationId: string, prompt: string): string[] {
	return [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--permission-mode",
		"default",
		"--allowedTools",
		CLAUDE_READ_TOOLS,
		// The vault's project settings define hooks (node .claude/scripts/...): user settings only, no MCP servers.
		"--setting-sources",
		"user",
		"--strict-mcp-config",
		...(effort ? ["--effort", effort] : []),
		...(conversationId ? ["--resume", conversationId] : []),
		// "--" ends the options: a message starting with "-" stays text.
		"--",
		prompt,
	];
}

/** Claude Code headless with the server's OAuth token, its stream converted by the desktop's EventConverter. */
export function runClaudeTurn(request: TurnRequest & { readonly claudePath: string; readonly token: string }): Turn {
	const started = Date.now();
	const converter = new EventConverter();
	let sessionId = request.conversationId;
	let sawEnd = false;
	let stopped = false;
	const emit = (event: UiEvent): void => {
		if (event.sessionId) sessionId = event.sessionId;
		if (event.kind === "turn-end" || event.kind === "run-error" || event.kind === "turn-cancelled") sawEnd = true;
		request.onEvent(event);
	};

	let child: ChildLike;
	try {
		child = request.jobUser.spawn(request.cwd, request.claudePath, claudeArgs(request.effort, request.conversationId, request.prompt), ["CLAUDE_CODE_OAUTH_TOKEN", "CI"], {
			...process.env,
			CLAUDE_CODE_OAUTH_TOKEN: request.token,
			CI: "1",
		});
	} catch (error) {
		emit({ kind: "run-error", sessionId, reason: "claude-not-found", message: String(error) });
		return { done: Promise.resolve(sessionId), stop: () => undefined };
	}

	const ended = closed(child);
	const stderr: string[] = [];
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	lines.on("line", (line) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		for (const event of converter.push(parsed)) emit(event);
	});
	child.stderr.on("data", (chunk: Buffer | string) => {
		for (const part of String(chunk).split(/\r?\n/)) if (part.trim()) stderr.push(part.trim());
		stderr.splice(0, Math.max(0, stderr.length - STDERR_LINES));
	});

	const done = new Promise<string>((resolve) => {
		let finished = false;
		const finish = (code: number | null, error?: Error): void => {
			if (finished) return;
			finished = true;
			lines.close();
			if (stopped && !sawEnd) emit({ kind: "turn-cancelled", sessionId, durationMs: Date.now() - started });
			else if (!sawEnd) {
				const message = [error?.message ?? `Claude exited with code ${code ?? "?"}.`, ...stderr].join("\n");
				emit({ kind: "run-error", sessionId, reason: error ? "claude-not-found" : "claude-exit", message });
			}
			resolve(sessionId);
		};
		child.on("close", (code) => finish(code));
		child.on("error", (error) => finish(null, error));
	});
	child.stdin.on("error", () => undefined);
	child.stdin.end();
	return {
		done,
		stop: () => {
			stopped = true;
			stopChild(child, ended, () => void request.jobUser.killSurvivors());
		},
	};
}
