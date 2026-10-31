import { create } from "zustand";
import type { UiEvent } from "../../main/claude/events.ts";
import type { Run } from "../../../runner/src/types.ts";
import { EMPTY_TREE, applyChatEvent, applyRuns, chatRootId, endChat, prune, type AgentTree, type ChatMeta } from "../agents/tree.ts";

/**
 * The Agents view's tree, fed by App.tsx from every chat event and by the
 * view's poll of the server's runs. Not saved: it describes what runs now.
 */

type AgentTreeState = {
	readonly tree: AgentTree;
	/** The node whose log the drawer shows. */
	readonly selected: string | null;
	readonly apply: (meta: ChatMeta, event: UiEvent) => void;
	readonly applyRuns: (runs: readonly Run[]) => void;
	/** A chat closed (its process gone): whatever still ran under it is cancelled. */
	readonly endChat: (chatId: string) => void;
	readonly select: (id: string | null) => void;
};

/** Time-based pruning runs with any change, at most this often, whether or not the view is open. */
export const PRUNE_EVERY_MS = 60_000;

export const useAgentTree = create<AgentTreeState>((set, get) => {
	let prunedAt = 0;
	/** `now` is the time the change was computed at. */
	const commit = (changed: AgentTree, now: number): void => {
		let next = changed;
		if (now - prunedAt >= PRUNE_EVERY_MS) {
			prunedAt = now;
			next = prune(next, now);
		}
		if (next === get().tree) return;
		const selected = get().selected;
		set(selected && !next.nodes[selected] ? { tree: next, selected: null } : { tree: next });
	};
	return {
		tree: EMPTY_TREE,
		selected: null,
		apply: (meta, event) => {
			const now = Date.now();
			const next = applyChatEvent(get().tree, meta, event, now);
			// A no-op event (most deltas never get here) does not trigger the periodic prune either.
			if (next !== get().tree) commit(next, now);
		},
		applyRuns: (runs) => {
			const now = Date.now();
			commit(
				applyRuns(
					get().tree,
					runs.map((run) => ({ id: run.id, jobName: run.jobName, status: run.status, startedAt: run.startedAt, finishedAt: run.endedAt })),
					now,
				),
				now,
			);
		},
		endChat: (chatId) => {
			const now = Date.now();
			commit(endChat(get().tree, chatId, now), now);
		},
		select: (selected) => set({ selected }),
	};
});

/** Only these events can change the tree; a text delta only while its chat is not yet marked running. */
const TREE_EVENTS: ReadonlySet<UiEvent["kind"]> = new Set(["tool-start", "tool-end", "subagent-text", "turn-end", "turn-cancelled", "run-error"]);

/**
 * Whether an event for this chat needs the tree at all. Called per token, so
 * it reads the store without allocating anything.
 */
export function treeWants(chatId: string, event: UiEvent): boolean {
	if (event.kind === "text-delta") return useAgentTree.getState().tree.nodes[chatRootId(chatId)]?.status !== "running";
	return TREE_EVENTS.has(event.kind);
}
