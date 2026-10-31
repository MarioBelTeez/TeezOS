import { describe, expect, test } from "vitest";
import { EMPTY_TREE, applyChatEvent, isAgyCommand, visibleRoots } from "./tree.ts";

const meta = { chatId: "c1", title: "Build 0.3.0", agent: "claude" as const, model: "opus" };
const start = (toolUseId: string, name: string, input: Record<string, unknown>, parentToolUseId: string | null = null) =>
	({ kind: "tool-start", sessionId: "s", toolUseId, name, input, parentToolUseId }) as const;
const end = (toolUseId: string, isError = false) => ({ kind: "tool-end", sessionId: "s", toolUseId, isError, content: "", parentToolUseId: null }) as const;

describe("agent tree", () => {
	test("a subagent nests under its chat and its own steps nest under it", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "Write the browser", model: "opus" }), 1);
		t = applyChatEvent(t, meta, start("B", "Read", { file_path: "src/main/index.ts" }, "A"), 2);
		expect(t.nodes["tool:A"]).toMatchObject({ parentId: "chat:c1", kind: "subagent", title: "Write the browser", status: "running" });
		expect(t.nodes["tool:A"]?.current).toContain("Read");
		expect(t.nodes["tool:B"]).toBeUndefined();
	});
	test("tool-end closes the subagent; a failed one is failed", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Task", { description: "x" }), 1);
		t = applyChatEvent(t, meta, end("A", true), 5);
		expect(t.nodes["tool:A"]).toMatchObject({ status: "failed", endedAt: 5 });
	});
	test("an agy command run from Bash is an Antigravity node", () => {
		const t = applyChatEvent(EMPTY_TREE, meta, start("G", "Bash", { command: 'agy -p "map the codebase" --add-dir C:/x' }), 1);
		expect(t.nodes["tool:G"]).toMatchObject({ kind: "antigravity", title: "map the codebase" });
	});
	test("stopping the chat cancels everything still running under it", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "x" }), 1);
		t = applyChatEvent(t, meta, { kind: "turn-cancelled", sessionId: "s", durationMs: 1 }, 9);
		expect(t.nodes["tool:A"]?.status).toBe("cancelled");
		expect(t.nodes["chat:c1"]?.status).toBe("cancelled");
	});
	test("isAgyCommand", () => {
		expect(isAgyCommand("agy -p x")).toBe(true);
		expect(isAgyCommand("cd x && agy.exe -p y")).toBe(true);
		expect(isAgyCommand("echo agy")).toBe(false);
		expect(isAgyCommand("npm run agyle")).toBe(false);
	});
	test("old finished roots drop out of view", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "x" }), 0);
		t = applyChatEvent(t, meta, { kind: "turn-end", sessionId: "s", ok: true, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: null }, 1);
		expect(visibleRoots(t, 1000)).toHaveLength(1);
		expect(visibleRoots(t, 31 * 60_000)).toHaveLength(0);
	});
});
