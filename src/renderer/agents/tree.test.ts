import { describe, expect, test } from "vitest";
import { EMPTY_TREE, applyChatEvent, endChat, isAgyCommand, visibleRoots } from "./tree.ts";

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
	test("Antigravity invoke_subagent nests with Role/model, survives parent turn-end, logs steps, and closes on tool-end or cancel", () => {
		const agyMeta = { chatId: "a1", title: "Agy chat", agent: "agy" as const, model: "gemini-4-neon-high" };
		const turnEnd = { kind: "turn-end", sessionId: "s", ok: true, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: null } as const;

		let t = applyChatEvent(EMPTY_TREE, agyMeta, start("S1", "invoke_subagent", { Role: "Backend Engineer", TypeName: "self", Model: "inherit" }), 1);
		t = applyChatEvent(t, agyMeta, start("S2", "invoke_subagent", { TypeName: "research", Model: "flash" }), 2);
		expect(t.nodes["tool:S1"]).toMatchObject({
			parentId: "chat:a1",
			kind: "subagent",
			title: "Backend Engineer",
			model: "gemini-4-neon-high",
			status: "running",
			background: true,
		});
		expect(t.nodes["tool:S2"]).toMatchObject({ title: "research", model: "flash", status: "running", background: true });

		// Parent turn ends: chat root is done, but background Antigravity subagents stay running.
		t = applyChatEvent(t, agyMeta, turnEnd, 5);
		expect(t.nodes["chat:a1"]).toMatchObject({ status: "done", endedAt: 5 });
		expect(t.nodes["tool:S1"]?.status).toBe("running");
		expect(t.nodes["tool:S2"]?.status).toBe("running");

		// Nested steps continue logging under the background subagent without reopening the chat root.
		t = applyChatEvent(t, agyMeta, start("S1:sub:1:0", "read_file", { Path: "src/app.ts" }, "S1"), 6);
		expect(t.nodes["tool:S1"]?.current).toBe("read_file: src/app.ts");
		expect(t.nodes["chat:a1"]?.status).toBe("done");

		// Own tool-end closes S1 while S2 keeps running.
		t = applyChatEvent(t, agyMeta, end("S1"), 8);
		expect(t.nodes["tool:S1"]).toMatchObject({ status: "done", endedAt: 8 });
		expect(t.nodes["tool:S2"]?.status).toBe("running");

		// turn-cancelled closes everything including running background subagents.
		const cancelled = applyChatEvent(t, agyMeta, { kind: "turn-cancelled", sessionId: "s", durationMs: 1 }, 9);
		expect(cancelled.nodes["tool:S2"]).toMatchObject({ status: "cancelled", endedAt: 9 });

		// endChat also closes remaining background subagents.
		const closed = endChat(t, "a1", 10);
		expect(closed.nodes["tool:S2"]).toMatchObject({ status: "cancelled", endedAt: 10 });
	});
	test("an agy command via run_command with CommandLine is an Antigravity node", () => {
		const t = applyChatEvent(EMPTY_TREE, meta, start("G2", "run_command", { CommandLine: 'agy -p "inspect logs"' }), 1);
		expect(t.nodes["tool:G2"]).toMatchObject({ kind: "antigravity", title: "inspect logs" });
	});
});
