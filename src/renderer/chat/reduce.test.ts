import { describe, expect, test } from "vitest";
import {
	EMPTY_CHAT,
	addApproval,
	applyPause,
	addUserMessage,
	decideApproval,
	reduceChat,
	type ChatView,
} from "./reduce.ts";
import type { UiEvent } from "../../main/claude/events.ts";

const fold = (chat: ChatView, events: UiEvent[]): ChatView => events.reduce(reduceChat, chat);

describe("reduceChat", () => {
	test("deltas build one assistant card, then the turn closes", () => {
		const chat = fold(addUserMessage(EMPTY_CHAT, "hi"), [
			{ kind: "session-ready", sessionId: "s1", model: "opus", permissionMode: "default", toolCount: 3, cwd: "C:\\x", slashCommands: ["om-standup"] },
			{ kind: "text-delta", sessionId: "s1", text: "Hel" },
			{ kind: "text-delta", sessionId: "s1", text: "lo" },
			{ kind: "turn-end", sessionId: "s1", ok: true, text: "Hello", durationMs: 1200, numTurns: 1, costUsd: 0.01, context: null },
		]);
		expect(chat.cards.map((c) => c.kind)).toEqual(["user", "assistant", "turn"]);
		expect(chat.cards[1]).toMatchObject({ text: "Hello" });
		expect(chat.running).toBe(false);
		expect(chat.sessionId).toBe("s1");
		expect(chat.slashCommands).toEqual(["om-standup"]);
		expect(chat.totalCostUsd).toBeCloseTo(0.01);
	});

	test("text after a tool call starts a new card", () => {
		const chat = fold(addUserMessage(EMPTY_CHAT, "read it"), [
			{ kind: "text-delta", sessionId: "s", text: "Reading." },
			{ kind: "tool-start", sessionId: "s", toolUseId: "t1", name: "Read", input: { file_path: "a.ts" }, parentToolUseId: null },
			{ kind: "tool-end", sessionId: "s", toolUseId: "t1", isError: false, content: "export {}", parentToolUseId: null },
			{ kind: "text-delta", sessionId: "s", text: "Done." },
		]);
		expect(chat.cards.map((c) => c.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
		expect(chat.cards[2]).toMatchObject({ status: "done", result: "export {}" });
		expect(chat.cards[3]).toMatchObject({ text: "Done." });
	});

	test("a failed tool is marked failed", () => {
		const chat = fold(EMPTY_CHAT, [
			{ kind: "tool-start", sessionId: "s", toolUseId: "t1", name: "Bash", input: {}, parentToolUseId: null },
			{ kind: "tool-end", sessionId: "s", toolUseId: "t1", isError: true, content: "boom", parentToolUseId: null },
		]);
		expect(chat.cards[0]).toMatchObject({ status: "failed" });
	});

	test("subagent prose with no Agent card draws nothing, and leaves the reply streaming", () => {
		const before = fold(addUserMessage(EMPTY_CHAT, "go"), [{ kind: "text-delta", sessionId: "s", text: "On it." }]);
		const after = fold(before, [{ kind: "subagent-text", sessionId: "s", parentToolUseId: "t1", text: "found it" }]);
		expect(after).toBe(before);
	});

	test("the context use, cost and turns come from each turn's end; a turn without usage keeps the last", () => {
		const end = (context: { used: number; window: number } | null) => ({ kind: "turn-end" as const, sessionId: "s", ok: true as const, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context });
		expect(EMPTY_CHAT.context).toBeNull();
		expect(EMPTY_CHAT.turns).toBe(0);
		const chat = fold(addUserMessage(EMPTY_CHAT, "a"), [end({ used: 30000, window: 200000 })]);
		expect(chat.context).toEqual({ used: 30000, window: 200000 });
		expect(chat.turns).toBe(1);
		const later = fold(addUserMessage(chat, "b"), [end(null)]);
		expect(later.context).toEqual({ used: 30000, window: 200000 });
		expect(later.turns).toBe(2);
	});

	test("compaction is a notice with the sizes, and the context shrinks to what is left", () => {
		const before = fold(addUserMessage(EMPTY_CHAT, "go"), [
			{ kind: "turn-end", sessionId: "s", ok: true, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: { used: 150000, window: 200000 } },
		]);
		const after = fold(before, [{ kind: "compacted", sessionId: "s", trigger: "manual", preTokens: 150000, postTokens: 20000 }]);
		expect(after.cards.at(-1)).toMatchObject({ kind: "notice", text: "Context compacted · 150k → 20k tokens" });
		expect(after.context).toEqual({ used: 20000, window: 200000 });
	});

	test("compaction without a size after it still says so, and leaves a streaming reply alone", () => {
		const before = fold(addUserMessage(EMPTY_CHAT, "go"), [{ kind: "text-delta", sessionId: "s", text: "On it." }]);
		const after = fold(before, [{ kind: "compacted", sessionId: "s", trigger: "auto", preTokens: 1500, postTokens: null }]);
		expect(after.cards.at(-1)).toMatchObject({ kind: "notice", text: "Context compacted · 2k tokens before" });
		expect(after.streamingId).toBe(before.streamingId);
		expect(after.context).toBeNull();
	});

	test("a subagent's tool calls nest under its Agent card, and its prose becomes the card's summary", () => {
		const chat = fold(addUserMessage(EMPTY_CHAT, "look around"), [
			{ kind: "tool-start", sessionId: "s", toolUseId: "A", name: "Agent", input: { description: "explore" }, parentToolUseId: null },
			{ kind: "tool-start", sessionId: "s", toolUseId: "B", name: "Grep", input: { pattern: "foo" }, parentToolUseId: "A" },
			{ kind: "subagent-text", sessionId: "s", parentToolUseId: "A", text: "found foo in a.ts" },
		]);
		expect(chat.cards.map((c) => c.kind)).toEqual(["user", "tool"]);
		const agent = chat.cards[1];
		expect(agent).toMatchObject({ toolUseId: "A", summary: "found foo in a.ts" });
		expect(agent?.kind === "tool" ? agent.steps : undefined).toEqual([
			{ toolUseId: "B", name: "Grep", input: { pattern: "foo" }, status: "running", result: "" },
		]);
	});

	test("a nested step finishes inside its Agent card; later prose is appended", () => {
		const chat = fold(EMPTY_CHAT, [
			{ kind: "tool-start", sessionId: "s", toolUseId: "A", name: "Task", input: {}, parentToolUseId: null },
			{ kind: "tool-start", sessionId: "s", toolUseId: "B", name: "Read", input: {}, parentToolUseId: "A" },
			{ kind: "tool-end", sessionId: "s", toolUseId: "B", isError: true, content: "no such file", parentToolUseId: "A" },
			{ kind: "subagent-text", sessionId: "s", parentToolUseId: "A", text: "first" },
			{ kind: "subagent-text", sessionId: "s", parentToolUseId: "A", text: "second" },
			{ kind: "tool-end", sessionId: "s", toolUseId: "A", isError: false, content: "report", parentToolUseId: null },
		]);
		expect(chat.cards).toHaveLength(1);
		expect(chat.cards[0]).toMatchObject({
			status: "done",
			result: "report",
			summary: "first\n\nsecond",
			steps: [{ toolUseId: "B", status: "failed", result: "no such file" }],
		});
	});

	test("a subagent of a subagent nests under the outer Agent card", () => {
		const chat = fold(EMPTY_CHAT, [
			{ kind: "tool-start", sessionId: "s", toolUseId: "A", name: "Agent", input: {}, parentToolUseId: null },
			{ kind: "tool-start", sessionId: "s", toolUseId: "B", name: "Agent", input: {}, parentToolUseId: "A" },
			{ kind: "tool-start", sessionId: "s", toolUseId: "C", name: "Bash", input: {}, parentToolUseId: "B" },
		]);
		expect(chat.cards).toHaveLength(1);
		expect(chat.cards[0]?.kind === "tool" ? chat.cards[0].steps?.map((s) => s.toolUseId) : []).toEqual(["B", "C"]);
	});

	test("a nested call does not end the reply in flight", () => {
		const chat = fold(addUserMessage(EMPTY_CHAT, "go"), [
			{ kind: "tool-start", sessionId: "s", toolUseId: "A", name: "Agent", input: {}, parentToolUseId: null },
			{ kind: "text-delta", sessionId: "s", text: "While it works" },
			{ kind: "tool-start", sessionId: "s", toolUseId: "B", name: "Read", input: {}, parentToolUseId: "A" },
			{ kind: "text-delta", sessionId: "s", text: ", I wait." },
		]);
		expect(chat.cards.filter((c) => c.kind === "assistant")).toEqual([expect.objectContaining({ text: "While it works, I wait." })]);
	});

	test("a call whose parent is unknown is still shown, at top level", () => {
		const chat = fold(EMPTY_CHAT, [
			{ kind: "tool-start", sessionId: "s", toolUseId: "B", name: "Read", input: {}, parentToolUseId: "gone" },
		]);
		expect(chat.cards).toEqual([expect.objectContaining({ kind: "tool", toolUseId: "B" })]);
	});

	test("an orphan nested call does not split the main reply in flight", () => {
		const chat = fold(addUserMessage(EMPTY_CHAT, "go"), [
			{ kind: "text-delta", sessionId: "s", text: "Working" },
			{ kind: "tool-start", sessionId: "s", toolUseId: "B", name: "Read", input: {}, parentToolUseId: "gone" },
			{ kind: "text-delta", sessionId: "s", text: " on it." },
		]);
		expect(chat.cards.filter((c) => c.kind === "assistant")).toEqual([expect.objectContaining({ text: "Working on it." })]);
		expect(chat.cards.some((c) => c.kind === "tool" && c.toolUseId === "B")).toBe(true);
	});

	test("an approval nobody answered expires when the turn ends", () => {
		let chat = addApproval(addUserMessage(EMPTY_CHAT, "write"), {
			id: "a1",
			toolName: "Write",
			input: { file_path: "x" },
		});
		chat = reduceChat(chat, { kind: "run-error", sessionId: "s", reason: "sdk-error", message: "died" });
		expect(chat.cards.find((c) => c.kind === "approval")).toMatchObject({ decision: "expired" });
		expect(chat.cards.at(-1)).toMatchObject({ kind: "error", reason: "sdk-error" });
	});

	test("a message refused for its images does not end the turn waiting on an approval", () => {
		let chat = addApproval(addUserMessage(EMPTY_CHAT, "write"), { id: "a1", toolName: "Write", input: {} });
		chat = addUserMessage(chat, "and look at this", ["data:image/jpeg;base64,AAAA"]);
		chat = reduceChat(chat, { kind: "run-error", sessionId: "", reason: "bad-image", message: "not an image" });
		expect(chat.cards.find((c) => c.kind === "approval")).toMatchObject({ decision: "pending" });
		expect(chat).toMatchObject({ running: true, pending: 1 });
		expect(chat.cards.at(-1)).toMatchObject({ kind: "error", reason: "bad-image" });
	});

	test("an answered approval keeps its answer", () => {
		let chat = addApproval(EMPTY_CHAT, { id: "a1", toolName: "Write", input: {} });
		chat = decideApproval(chat, "a1", "allow");
		chat = reduceChat(chat, { kind: "turn-cancelled", sessionId: "s", durationMs: 10 });
		expect(chat.cards[0]).toMatchObject({ decision: "allow" });
		expect(chat.cards[1]).toMatchObject({ kind: "cancelled" });
	});

	test("cost: each turn is the difference between the session's running totals", () => {
		const turn = (costUsd: number) => ({ kind: "turn-end" as const, sessionId: "s", ok: true as const, text: "", durationMs: 1, numTurns: 1, costUsd, context: null });
		let chat = addUserMessage(EMPTY_CHAT, "a");
		chat = reduceChat(chat, turn(0.1));
		chat = reduceChat(addUserMessage(chat, "b"), turn(0.25));
		expect(chat.cards.filter((c) => c.kind === "turn").map((c) => (c.kind === "turn" ? Number(c.costUsd.toFixed(2)) : 0))).toEqual([0.1, 0.15]);
		expect(chat.totalCostUsd).toBeCloseTo(0.25);
	});

	test("a message sent mid-turn keeps the chat running until its own answer", () => {
		const end = { kind: "turn-end" as const, sessionId: "s", ok: true as const, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: null };
		const withImage = addUserMessage(EMPTY_CHAT, "look", ["data:image/png;base64,AAAA"]);
		expect(withImage.cards[0]).toMatchObject({ kind: "user", text: "look", images: ["data:image/png;base64,AAAA"] });
		let chat = addUserMessage(addUserMessage(EMPTY_CHAT, "first"), "second");
		chat = reduceChat(chat, end);
		expect(chat.running).toBe(true);
		chat = reduceChat(chat, end);
		expect(chat.running).toBe(false);
	});

	test("card ids stay unique across actions", () => {
		const chat = fold(addUserMessage(addUserMessage(EMPTY_CHAT, "a"), "b"), [
			{ kind: "text", sessionId: "s", text: "x" },
			{ kind: "text", sessionId: "s", text: "y" },
		]);
		const ids = chat.cards.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("applyPause", () => {
	test("waiting records when the chat resumes", () => {
		const chat = applyPause(EMPTY_CHAT, { kind: "waiting", chatId: "a", resumesAt: 5000, estimated: false });
		expect(chat.pause).toEqual({ resumesAt: 5000, estimated: false });
	});

	test("cleared removes the banner and adds no card", () => {
		const waiting = applyPause(EMPTY_CHAT, { kind: "waiting", chatId: "a", resumesAt: 5000, estimated: true });
		const chat = applyPause(waiting, { kind: "cleared", chatId: "a" });
		expect(chat.pause).toBeNull();
		expect(chat.cards).toHaveLength(0);
	});

	test("resumed clears the banner, notes the automatic continue and marks the chat working", () => {
		const waiting = applyPause(EMPTY_CHAT, { kind: "waiting", chatId: "a", resumesAt: 5000, estimated: false });
		const chat = applyPause(waiting, { kind: "resumed", chatId: "a" });
		expect(chat.pause).toBeNull();
		expect(chat.running).toBe(true);
		expect(chat.pending).toBe(1);
		expect(chat.cards.at(-1)).toMatchObject({ kind: "notice", text: "Continued automatically after the limit reset" });
	});
});
