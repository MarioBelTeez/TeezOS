import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EMPTY_TREE, HIDE_AFTER_MS } from "../agents/tree.ts";
import { useAgentTree } from "./agent-tree.ts";

const meta = (chatId: string) => ({ chatId, title: chatId, agent: "claude" as const, model: "opus" });
const start = (toolUseId: string, name = "Read", input: Record<string, unknown> = { file_path: "x" }) =>
	({ kind: "tool-start", sessionId: "s", toolUseId, name, input, parentToolUseId: null }) as const;
const turnEnd = { kind: "turn-end", sessionId: "s", ok: true, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: null } as const;

describe("agent tree store", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		useAgentTree.setState({ tree: EMPTY_TREE, selected: null });
	});
	afterEach(() => vi.useRealTimers());

	test("any change prunes on a timer, even with the view closed and no new chat", () => {
		const store = useAgentTree.getState();
		store.apply(meta("old"), start("o"));
		store.apply(meta("old"), turnEnd);
		store.apply(meta("live"), start("l1"));
		vi.setSystemTime(1_000_000 + HIDE_AFTER_MS + 120_000);
		// An existing chat's next call: no new root, no turn end; the periodic prune still runs.
		store.apply(meta("live"), start("l2"));
		expect(useAgentTree.getState().tree.nodes["chat:old"]).toBeUndefined();
		expect(useAgentTree.getState().tree.nodes["chat:live"]).toBeDefined();
	});

	test("a selection whose node is pruned is cleared", () => {
		const store = useAgentTree.getState();
		store.apply(meta("old"), start("a", "Agent", { description: "x" }));
		store.apply(meta("old"), turnEnd);
		store.select("tool:a");
		vi.setSystemTime(1_000_000 + HIDE_AFTER_MS + 120_000);
		store.endChat("old");
		store.apply(meta("live"), start("l1"));
		expect(useAgentTree.getState().tree.nodes["tool:a"]).toBeUndefined();
		expect(useAgentTree.getState().selected).toBeNull();
	});

	test("a no-op event leaves the store untouched", () => {
		const store = useAgentTree.getState();
		store.apply(meta("c"), start("r"));
		const before = useAgentTree.getState().tree;
		store.apply(meta("c"), { kind: "text-delta", sessionId: "s", text: "x" });
		expect(useAgentTree.getState().tree).toBe(before);
	});
});
