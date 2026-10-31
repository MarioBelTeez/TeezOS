import type { Job, RunEvent, RunStatus } from "../../../runner/src/types.ts";
import { runItems } from "../../../src/main/runner/run-items.ts";
import { addNotice, addUserMessage, EMPTY_CHAT, reduceChat, type ChatView } from "../../../src/renderer/chat/reduce.ts";

/**
 * A run's log drawn like a chat, the way the desktop's Automations view reads
 * it: the job's prompt, then Claude's or Antigravity's own events converted to
 * cards, with the runner's notes in between. Rebuilt from all the events each
 * time (the converters are stateful and a run's log is bounded).
 */
export function runView(job: Pick<Job, "prompt"> | null, events: readonly RunEvent[]): ChatView {
	let view = EMPTY_CHAT;
	for (const item of runItems(job, events)) {
		if (item.kind === "user") view = { ...addUserMessage(view, item.text), running: false };
		else if (item.kind === "notice") view = addNotice(view, item.text);
		else view = reduceChat(view, item);
	}
	return { ...view, running: false, pending: 0, streamingId: null };
}

/** The seq to ask for events after: the last one seen, or -1 for all. */
export function lastSeq(events: readonly RunEvent[]): number {
	return events.reduce((max, event) => Math.max(max, event.seq), -1);
}

/** Events in seq order with any repeats dropped (a long poll can overlap the previous answer). */
export function mergeEvents(known: readonly RunEvent[], incoming: readonly RunEvent[]): RunEvent[] {
	const seen = new Set(known.map((event) => event.seq));
	return [...known, ...incoming.filter((event) => !seen.has(event.seq))].sort((a, b) => a.seq - b.seq);
}

export const STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
	running: "Running",
	ok: "Done",
	error: "Failed",
	cancelled: "Cancelled",
	timeout: "Timed out",
};
