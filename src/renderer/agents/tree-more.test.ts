import { describe, expect, test } from "vitest";
import { EMPTY_TREE, applyChatEvent, applyRuns, childrenOf, endChat, isAgyCommand, visibleRoots } from "./tree.ts";

const meta = { chatId: "c1", title: "Build 0.3.0", agent: "claude" as const, model: "opus" };
const start = (toolUseId: string, name: string, input: Record<string, unknown>, parentToolUseId: string | null = null) =>
	({ kind: "tool-start", sessionId: "s", toolUseId, name, input, parentToolUseId }) as const;
const end = (toolUseId: string, isError = false) => ({ kind: "tool-end", sessionId: "s", toolUseId, isError, content: "", parentToolUseId: null }) as const;
const delta = { kind: "text-delta", sessionId: "s", text: "hi" } as const;
const turnEnd = { kind: "turn-end", sessionId: "s", ok: true, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: null } as const;

describe("agent tree: chat root", () => {
	test("the root carries the chat's title and model and runs from the first delta", () => {
		const t = applyChatEvent(EMPTY_TREE, meta, delta, 3);
		expect(t.nodes["chat:c1"]).toMatchObject({ kind: "chat", parentId: null, title: "Build 0.3.0", model: "opus", status: "running", startedAt: 3, endedAt: null });
		expect(t.order).toEqual(["chat:c1"]);
	});
	test("a delta while the chat is already running returns the same tree", () => {
		const t = applyChatEvent(EMPTY_TREE, meta, delta, 3);
		expect(applyChatEvent(t, meta, delta, 4)).toBe(t);
	});
	test("events that do not change the tree return it unchanged", () => {
		expect(applyChatEvent(EMPTY_TREE, meta, turnEnd, 1)).toBe(EMPTY_TREE);
		expect(applyChatEvent(EMPTY_TREE, meta, { kind: "text", sessionId: "s", text: "x" }, 1)).toBe(EMPTY_TREE);
		const t = applyChatEvent(EMPTY_TREE, meta, start("R", "Read", { file_path: "a" }), 1);
		expect(applyChatEvent(t, meta, end("R"), 2)).toBe(t);
	});
	test("a new turn restarts a finished root", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, delta, 1);
		t = applyChatEvent(t, meta, turnEnd, 2);
		expect(t.nodes["chat:c1"]).toMatchObject({ status: "done", endedAt: 2 });
		t = applyChatEvent(t, { ...meta, title: "Renamed" }, delta, 10);
		expect(t.nodes["chat:c1"]).toMatchObject({ status: "running", startedAt: 10, endedAt: null, title: "Renamed" });
	});
	test("top-level tools are steps of the chat", () => {
		const t = applyChatEvent(EMPTY_TREE, meta, start("R", "Read", { file_path: "src/a.ts" }), 7);
		expect(t.nodes["chat:c1"]?.steps).toEqual([{ at: 7, text: "Read: src/a.ts", seq: 0 }]);
		expect(t.nodes["chat:c1"]?.current).toBe("Read: src/a.ts");
	});
	test("a run error fails the chat and everything running under it, finished nodes keep their status", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "a" }), 1);
		t = applyChatEvent(t, meta, start("B", "Agent", { description: "b" }), 1);
		t = applyChatEvent(t, meta, end("A"), 2);
		t = applyChatEvent(t, meta, { kind: "run-error", sessionId: "s", reason: "x", message: "y" }, 3);
		expect(t.nodes["tool:A"]).toMatchObject({ status: "done", endedAt: 2 });
		expect(t.nodes["tool:B"]).toMatchObject({ status: "failed", endedAt: 3 });
		expect(t.nodes["chat:c1"]?.status).toBe("failed");
	});
	test("endChat cancels a chat that was closed mid-turn", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "a" }), 1);
		t = endChat(t, "c1", 4);
		expect(t.nodes["chat:c1"]).toMatchObject({ status: "cancelled", endedAt: 4 });
		expect(t.nodes["tool:A"]?.status).toBe("cancelled");
		expect(endChat(t, "c1", 5)).toBe(t);
		expect(endChat(t, "nope", 5)).toBe(t);
	});
});

describe("agent tree: subagents", () => {
	test("title falls back to subagent_type, then Subagent; model is input.model or empty", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { subagent_type: "code-reviewer" }), 1);
		t = applyChatEvent(t, meta, start("B", "Task", {}), 1);
		expect(t.nodes["tool:A"]).toMatchObject({ title: "code-reviewer", model: "" });
		expect(t.nodes["tool:B"]).toMatchObject({ title: "Subagent", model: "" });
	});
	test("a subagent started by a subagent nests under it", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "outer" }), 1);
		t = applyChatEvent(t, meta, start("B", "Agent", { description: "inner" }, "A"), 2);
		expect(t.nodes["tool:B"]?.parentId).toBe("tool:A");
		expect(childrenOf(t)["tool:A"]).toEqual(["tool:B"]);
		expect(childrenOf(t)["chat:c1"]).toEqual(["tool:A"]);
	});
	test("a subagent's prose is a step", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "x" }), 1);
		t = applyChatEvent(t, meta, { kind: "subagent-text", sessionId: "s", parentToolUseId: "A", text: "y".repeat(300) }, 2);
		const steps = t.nodes["tool:A"]?.steps ?? [];
		expect(steps.at(-1)?.text).toBe(`says: ${"y".repeat(120)}`);
	});
	test("ending a subagent closes what still runs under it", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "x" }), 1);
		t = applyChatEvent(t, meta, start("B", "Agent", { description: "y" }, "A"), 2);
		t = applyChatEvent(t, meta, end("A"), 3);
		expect(t.nodes["tool:B"]).toMatchObject({ status: "done", endedAt: 3 });
	});
	test("steps are capped at 200 per node", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "x" }), 0);
		for (let i = 0; i < 250; i += 1) t = applyChatEvent(t, meta, start(`r${i}`, "Read", { file_path: `f${i}` }, "A"), i);
		const steps = t.nodes["tool:A"]?.steps ?? [];
		expect(steps).toHaveLength(200);
		expect(steps.at(-1)?.text).toBe("Read: f249");
		expect(steps[0]?.text).toBe("Read: f50");
	});
});

describe("agent tree: Antigravity", () => {
	test("the title is the first line of the prompt, at most 60 characters; --model is read", () => {
		const long = "a".repeat(80);
		const t = applyChatEvent(EMPTY_TREE, meta, start("G", "Bash", { command: `agy -p '${long}\nsecond line' --model gemini-3.1-pro-high` }), 1);
		expect(t.nodes["tool:G"]).toMatchObject({ title: "a".repeat(60), model: "gemini-3.1-pro-high", parentId: "chat:c1" });
	});
	test("a prompt read from a file is an 'Antigravity run'", () => {
		const t = applyChatEvent(EMPTY_TREE, meta, start("G", "PowerShell", { command: 'agy -p (Get-Content -Raw "C:\\t\\p.txt") --add-dir "C:\\v"' }), 1);
		expect(t.nodes["tool:G"]).toMatchObject({ kind: "antigravity", title: "Antigravity run" });
	});
	test("its tool result ends it", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("G", "Bash", { command: "agy -p x" }), 1);
		t = applyChatEvent(t, meta, end("G"), 4);
		expect(t.nodes["tool:G"]).toMatchObject({ status: "done", endedAt: 4 });
	});
	test("a Bash call that is not agy is a plain step", () => {
		const t = applyChatEvent(EMPTY_TREE, meta, start("G", "Bash", { command: "echo agy" }), 1);
		expect(t.nodes["tool:G"]).toBeUndefined();
		expect(t.nodes["chat:c1"]?.current).toBe("Bash: echo agy");
	});
	test("isAgyCommand accepts paths, pipes and the call operator", () => {
		expect(isAgyCommand('& "C:\\Tools\\agy.exe" -p x')).toBe(true);
		expect(isAgyCommand("C:/bin/agy -p x")).toBe(true);
		expect(isAgyCommand("type p.txt | agy -p -")).toBe(true);
		expect(isAgyCommand("(agy -p x)")).toBe(true);
		expect(isAgyCommand("agy")).toBe(true);
		expect(isAgyCommand("git commit -m agy")).toBe(false);
		expect(isAgyCommand("ls agy/")).toBe(false);
		expect(isAgyCommand("magy -p x")).toBe(false);
	});
});

describe("agent tree: automations", () => {
	const run = { id: "r1", jobName: "Morning digest", status: "running", startedAt: 100, finishedAt: null };
	test("runs become automation roots", () => {
		const t = applyRuns(EMPTY_TREE, [run], 200);
		expect(t.nodes["run:r1"]).toMatchObject({ kind: "automation", parentId: null, title: "Morning digest", status: "running", startedAt: 100, endedAt: null, model: "" });
	});
	test("an unchanged poll returns the same tree; a finished run updates", () => {
		const t = applyRuns(EMPTY_TREE, [run], 200);
		expect(applyRuns(t, [run], 300)).toBe(t);
		const next = applyRuns(t, [{ ...run, status: "ok", finishedAt: 400 }], 500);
		expect(next.nodes["run:r1"]).toMatchObject({ status: "done", endedAt: 400 });
		expect(applyRuns(t, [{ ...run, status: "timeout", finishedAt: 400 }], 500).nodes["run:r1"]?.status).toBe("failed");
		expect(applyRuns(t, [{ ...run, status: "cancelled", finishedAt: 400 }], 500).nodes["run:r1"]?.status).toBe("cancelled");
	});
	test("runs that finished long ago are not added", () => {
		const t = applyRuns(EMPTY_TREE, [{ ...run, status: "ok", finishedAt: 1000 }], 1000 + 31 * 60_000);
		expect(t).toBe(EMPTY_TREE);
	});
	test("visible roots are newest first", () => {
		let t = applyRuns(EMPTY_TREE, [run, { ...run, id: "r2", startedAt: 150 }], 200);
		t = applyChatEvent(t, meta, delta, 120);
		expect(visibleRoots(t, 200).map((n) => n.id)).toEqual(["run:r2", "chat:c1", "run:r1"]);
	});
	test("finished roots older than 30 minutes are pruned from the store with their children", () => {
		let t = applyChatEvent(EMPTY_TREE, meta, start("A", "Agent", { description: "x" }), 0);
		t = applyChatEvent(t, meta, turnEnd, 1);
		t = applyRuns(t, [run], 31 * 60_000);
		expect(t.nodes["chat:c1"]).toBeUndefined();
		expect(t.nodes["tool:A"]).toBeUndefined();
		expect(t.order).toEqual(["run:r1"]);
	});
});
