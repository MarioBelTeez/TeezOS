import { EventConverter } from "./events.ts";
import type { QueryFn, QueryHandle } from "./service.ts";

/**
 * `/btw`: a side question about the chat that leaves the chat alone.
 *
 * The chat's session is forked (`resume` + `forkSession`), so the answer sees
 * the whole conversation while the main transcript and session never learn
 * the question was asked. One turn, no tools, plan mode: it answers from what
 * is already in context and cannot change anything. The fork is deleted
 * afterwards so it never turns up under Past sessions.
 */

export type BtwDeps = {
	readonly query: QueryFn;
	readonly claudePath: string;
	readonly cwd: string;
	/** "" = account default. */
	readonly model: string;
	/** The chat's session; null = no context yet. */
	readonly sessionId: string | null;
	/** 1..4000 chars. */
	readonly question: string;
	readonly onDelta: (text: string) => void;
	readonly onDone: (text: string) => void;
	readonly onError: (message: string) => void;
	/** The SDK's deleteSession, injected. */
	readonly deleteSession: (id: string) => Promise<void>;
};

export function runBtw(deps: BtwDeps): { cancel(): void } {
	// A string prompt has no live control channel, so `interrupt()` may be
	// refused; the abort controller is what reliably ends the process.
	const abort = new AbortController();
	const options: Record<string, unknown> = {
		cwd: deps.cwd,
		pathToClaudeCodeExecutable: deps.claudePath,
		includePartialMessages: true,
		maxTurns: 1,
		allowedTools: [],
		// `allowedTools` only skips prompts; an empty `tools` removes the
		// built-in tools themselves, which is what "no tools" means here.
		tools: [],
		permissionMode: "plan",
		// Isolated: omitted, settingSources loads every settings file, and with
		// them the user's hooks (a vault's SessionStart pull) and MCP servers,
		// whose tools `tools: []` would not remove. The fork already carries
		// the chat's context, CLAUDE.md included.
		settingSources: [],
		strictMcpConfig: true,
		mcpServers: {},
		abortController: abort,
		...(deps.model ? { model: deps.model } : {}),
		...(deps.sessionId ? { resume: deps.sessionId, forkSession: true } : {}),
	};

	let cancelled = false;
	let settled = false;
	const finish = (report: () => void): void => {
		if (settled || cancelled) return;
		settled = true;
		report();
	};

	let handle: QueryHandle;
	try {
		handle = deps.query({ prompt: deps.question, options });
	} catch (error) {
		// Reported a tick later, as every other outcome is: the caller has its
		// handle (and its id) before the first event.
		queueMicrotask(() => finish(() => deps.onError(messageOf(error))));
		return { cancel: () => undefined };
	}

	void (async () => {
		const converter = new EventConverter();
		let forkedId = "";
		let streamed = "";
		try {
			for await (const message of handle) {
				const id = sessionIdOf(message);
				if (id) forkedId = id;
				for (const event of converter.push(message)) {
					if (cancelled) continue;
					if (event.kind === "text-delta") {
						streamed += event.text;
						deps.onDelta(event.text);
					} else if (event.kind === "turn-end") {
						finish(() => deps.onDone(event.text || streamed));
					} else if (event.kind === "run-error") {
						finish(() => deps.onError(event.message));
					} else if (event.kind === "turn-cancelled") {
						finish(() => deps.onError("The side question was cancelled."));
					}
				}
			}
			finish(() => deps.onError("The side question ended without an answer."));
		} catch (error) {
			finish(() => deps.onError(messageOf(error)));
		} finally {
			// Whatever happened, a session written for this question goes. The
			// chat's own session is never the one deleted.
			if (forkedId && forkedId !== deps.sessionId) {
				deps.deleteSession(forkedId).catch(() => undefined);
			}
		}
	})();

	return {
		cancel: () => {
			if (cancelled || settled) return;
			cancelled = true;
			try {
				handle.interrupt?.()?.catch(() => undefined);
			} catch {
				// Refused outside streaming mode; the abort below still ends it.
			}
			abort.abort();
		},
	};
}

function sessionIdOf(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const id = (message as Record<string, unknown>)["session_id"];
	return typeof id === "string" ? id : "";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
