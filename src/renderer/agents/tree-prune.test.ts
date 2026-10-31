import { describe, expect, test } from "vitest";
import { EMPTY_TREE, HIDE_AFTER_MS, MAX_FINISHED_PER_ROOT, applyChatEvent, endChat, prune, type AgentTree } from "./tree.ts";

const meta = { chatId: "c1", title: "Long chat", agent: "claude" as const, model: "opus" };
const start = (toolUseId: string, name: string, input: Record<string, unknown>, parentToolUseId: string | null = null) =>
	({ kind: "tool-start", sessionId: "s", toolUseId, name, input, parentToolUseId }) as const;
const end = (toolUseId: string, isError = false) => ({ kind: "tool-end", sessionId: "s", toolUseId, isError, content: "", parentToolUseId: null }) as const;
const turnEnd = { kind: "turn-end", sessionId: "s", ok: true, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: null } as const;

/** A subagent that starts and finishes at `at`. */
function finishedSubagent(tree: AgentTree, id: string, at: number, parent: string | null = null): AgentTree {
	const started = applyChatEvent(tree, meta, start(id, "Agent", { description: id }, parent), at);
	return applyChatEvent(started, meta, end(id), at);
}

describe("agent tree: pruning", () => {
	test("a long-lived chat lets go of subagents that finished more than 30 minutes ago, with their subtrees", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "old" }), 0);
		t = finishedSubagent(t, "A2", 0, "A");
		t = applyChatEvent(t, meta, end("A"), 0);
		t = finishedSubagent(t, "B", HIDE_AFTER_MS);
		const later = HIDE_AFTER_MS + 1;
		// The chat root keeps running across turns, so it is never a stale root itself.
		t = applyChatEvent(t, meta, start("R", "Read", { file_path: "x" }), later);
		const pruned = prune(t, later);
		expect(pruned.nodes["tool:A"]).toBeUndefined();
		expect(pruned.nodes["tool:A2"]).toBeUndefined();
		expect(pruned.nodes["tool:B"]).toBeDefined();
		expect(pruned.nodes["chat:c1"]).toBeDefined();
		expect(pruned.order).toEqual(["chat:c1", "tool:B"]);
	});

	test("a root keeps only its newest finished descendants", () => {
		let t = EMPTY_TREE;
		for (let i = 0; i < MAX_FINISHED_PER_ROOT + 10; i += 1) t = finishedSubagent(t, `s${i}`, i);
		const pruned = prune(t, MAX_FINISHED_PER_ROOT + 10);
		const kept = pruned.order.filter((id) => id.startsWith("tool:"));
		expect(kept).toHaveLength(MAX_FINISHED_PER_ROOT);
		expect(kept[0]).toBe("tool:s10");
		expect(kept.at(-1)).toBe(`tool:s${MAX_FINISHED_PER_ROOT + 9}`);
	});

	test("nothing is dropped while something under it still runs", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "outer" }), 0);
		t = applyChatEvent(t, meta, end("A"), 0);
		// A late call names the finished subagent as its parent.
		t = applyChatEvent(t, meta, start("B", "Agent", { description: "inner" }, "A"), 1);
		const pruned = prune(t, HIDE_AFTER_MS + 10);
		expect(pruned.nodes["tool:A"]).toBeDefined();
		expect(pruned.nodes["tool:B"]?.status).toBe("running");
	});

	test("prune returns the same tree when nothing goes", () => {
		const t = finishedSubagent(EMPTY_TREE, "A", 0);
		expect(prune(t, 1)).toBe(t);
		expect(prune(EMPTY_TREE, 1)).toBe(EMPTY_TREE);
	});

	test("a turn's end prunes the chat's old subagents", () => {
		let t = finishedSubagent(EMPTY_TREE, "A", 0);
		t = applyChatEvent(t, meta, start("R", "Read", { file_path: "x" }), HIDE_AFTER_MS + 5);
		expect(t.nodes["tool:A"]).toBeDefined();
		t = applyChatEvent(t, meta, turnEnd, HIDE_AFTER_MS + 6);
		expect(t.nodes["tool:A"]).toBeUndefined();
		expect(t.nodes["chat:c1"]?.status).toBe("done");
	});

	test("closing a chat prunes stale roots too", () => {
		const other = { ...meta, chatId: "c2" };
		let t = applyChatEvent(EMPTY_TREE, other, start("X", "Read", { file_path: "x" }), 0);
		t = applyChatEvent(t, other, turnEnd, 0);
		t = applyChatEvent(t, meta, start("R", "Read", { file_path: "x" }), 1);
		t = endChat(t, "c1", HIDE_AFTER_MS + 1);
		expect(t.nodes["chat:c2"]).toBeUndefined();
		expect(t.nodes["chat:c1"]?.status).toBe("cancelled");
	});

	test("step ids keep counting past the 200-step cap", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "x" }), 0);
		for (let i = 0; i < 250; i += 1) t = applyChatEvent(t, meta, start(`r${i}`, "Read", { file_path: `f${i}` }, "A"), i);
		const steps = t.nodes["tool:A"]?.steps ?? [];
		expect(steps[0]?.seq).toBe(50);
		expect(steps.at(-1)?.seq).toBe(249);
	});
});
