import type { UiEvent } from "../claude/events.ts";

/**
 * `/btw` in an Antigravity chat. agy cannot fork a conversation, so the
 * window prepends the hand-over summary to the question and this runs it as
 * a fresh one-off `agy` (never resuming the chat's conversation, which would
 * add the question to it). The run is disposed as soon as it ends, so no
 * process outlives the answer.
 */

type OneOffSession = {
	send(text: string): void;
	dispose(): void;
};

export type AgyBtwDeps = {
	readonly createSession: (onEvent: (event: UiEvent) => void) => OneOffSession;
	readonly question: string;
	readonly onDelta: (text: string) => void;
	readonly onDone: (text: string) => void;
	readonly onError: (message: string) => void;
};

export function runAgyBtw(deps: AgyBtwDeps): { cancel(): void } {
	let ended = false;
	let answer = "";
	let session: OneOffSession | null = null;

	const end = (report: () => void): void => {
		if (ended) return;
		ended = true;
		report();
		// Created synchronously below; an event can only come after that.
		session?.dispose();
	};

	session = deps.createSession((event) => {
		if (ended) return;
		switch (event.kind) {
			case "text-delta":
			case "text":
				answer += event.text;
				deps.onDelta(event.text);
				return;
			case "turn-end":
				end(() => deps.onDone(answer || event.text));
				return;
			case "run-error":
				end(() => deps.onError(event.message));
				return;
			case "turn-cancelled":
				end(() => deps.onError("The side question was cancelled."));
				return;
			default:
				return;
		}
	});
	session.send(deps.question);

	return {
		cancel: () => end(() => undefined),
	};
}
