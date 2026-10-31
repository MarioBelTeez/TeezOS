import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventConverter } from "./events.ts";
import type { UiEvent } from "./events.ts";

/**
 * These tests run against NDJSON recorded from real Claude Code runs on this
 * machine (see __fixtures__), not hand-written JSON. The shapes the SDK emits
 * are the thing under test; inventing them would test only my memory of them.
 */

function fixture(name: string): unknown[] {
	const path = join(import.meta.dirname, "__fixtures__", `${name}.ndjson`);
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as unknown);
}

function convert(messages: readonly unknown[]): UiEvent[] {
	const converter = new EventConverter();
	return messages.flatMap((message) => converter.push(message));
}

const kinds = (events: readonly UiEvent[]): string[] => events.map((e) => e.kind);

describe("EventConverter — a recorded tool-use run", () => {
	const events = convert(fixture("tool-use-read"));

	test("opens with the session, in order, and closes with the turn", () => {
		expect(kinds(events)).toEqual([
			"rate-limit",
			"session-ready",
			"tool-start",
			"tool-end",
			"text",
			"turn-end",
		]);
	});

	test("session-ready carries what the header shows", () => {
		const ready = events.find((e) => e.kind === "session-ready");
		expect(ready).toMatchObject({
			model: "claude-opus-5",
			permissionMode: "auto",
		});
		if (ready?.kind === "session-ready") {
			expect(ready.sessionId).toHaveLength(36);
			expect(ready.toolCount).toBeGreaterThan(100);
		}
	});

	test("the tool call keeps its name and input, and pairs with its result", () => {
		const start = events.find((e) => e.kind === "tool-start");
		const end = events.find((e) => e.kind === "tool-end");
		expect(start).toMatchObject({ name: "Read" });
		if (start?.kind === "tool-start" && end?.kind === "tool-end") {
			expect(start.input).toHaveProperty("file_path");
			expect(end.toolUseId).toBe(start.toolUseId);
			expect(end.isError).toBe(false);
		}
	});

	test("the assistant's answer survives as text", () => {
		const text = events.find((e) => e.kind === "text");
		expect(text?.kind === "text" && text.text).toContain("hello from the spike");
	});

	test("turn-end reports cost and duration for the footer", () => {
		const end = events.at(-1);
		expect(end?.kind).toBe("turn-end");
		if (end?.kind === "turn-end") {
			expect(end.ok).toBe(true);
			expect(end.durationMs).toBeGreaterThan(0);
			expect(end.numTurns).toBeGreaterThan(0);
			expect(typeof end.costUsd).toBe("number");
		}
	});
});

describe("EventConverter — a recorded streaming run", () => {
	const events = convert(fixture("streaming-text"));

	test("emits the text as deltas, which rebuild the sentence", () => {
		const deltas = events.filter((e) => e.kind === "text-delta");
		expect(deltas.length).toBe(4);
		const rebuilt = deltas
			.map((e) => (e.kind === "text-delta" ? e.text : ""))
			.join("");
		expect(rebuilt).toBe("the quick brown fox jumps over the lazy dog");
	});

	test("does not also emit the completed assistant text — that would double it", () => {
		expect(kinds(events)).not.toContain("text");
	});

	test("drops the envelope events the UI has no use for", () => {
		// message_start/stop, content_block_start/stop, message_delta, status
		expect(kinds(events)).toEqual([
			"rate-limit",
			"session-ready",
			"text-delta",
			"text-delta",
			"text-delta",
			"text-delta",
			"turn-end",
		]);
	});
});

describe("EventConverter — noise and failures", () => {
	test("hook events are dropped, however large", () => {
		const converter = new EventConverter();
		const hook = {
			type: "system",
			subtype: "hook_response",
			hook_name: "SessionStart",
			output: "x".repeat(30_000),
		};
		expect(converter.push(hook)).toEqual([]);
	});

	test("an unknown event type is ignored rather than crashing", () => {
		const converter = new EventConverter();
		expect(converter.push({ type: "something_new_in_a_later_release" })).toEqual([]);
		expect(converter.push(null)).toEqual([]);
		expect(converter.push("not an object")).toEqual([]);
	});

	/**
	 * Pressing Stop is not a failure, but the SDK reports it as one: an
	 * interrupted turn comes back as `error_during_execution` with `is_error:
	 * true`, `result: null` and — the only thing that distinguishes it —
	 * `terminal_reason: "aborted_streaming"`. The user hit Stop to cancel a prompt
	 * and got a red error card reading "error_during_execution".
	 *
	 * Field values below were observed on this machine by interrupting a real
	 * run, not guessed.
	 */
	test("stopping a turn reads as cancelled, not as a failure", () => {
		const converter = new EventConverter();
		const events = converter.push({
			type: "result",
			subtype: "error_during_execution",
			is_error: true,
			result: null,
			stop_reason: null,
			terminal_reason: "aborted_streaming",
			session_id: "11111111-2222-3333-4444-555555555555",
			duration_ms: 6200,
			num_turns: 1,
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "turn-cancelled", durationMs: 6200 });
	});

	test("a failure that was not a cancel is still an error", () => {
		const converter = new EventConverter();
		const [event] = converter.push({
			type: "result",
			subtype: "error_during_execution",
			is_error: true,
			terminal_reason: "errored",
			session_id: "11111111-2222-3333-4444-555555555555",
			duration_ms: 900,
		});
		expect(event).toMatchObject({ kind: "run-error" });
	});

	// Synthetic: recording a real failure costs a quota-burning error run, and
	// the subtypes are fixed by the SDK's own result type.
	test("a failed result becomes a run-error, not a turn-end", () => {
		const converter = new EventConverter();
		const events = converter.push({
			type: "result",
			subtype: "error_max_turns",
			session_id: "11111111-2222-3333-4444-555555555555",
			duration_ms: 1200,
			num_turns: 12,
			is_error: true,
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "run-error", reason: "error_max_turns" });
	});

	test("a tool result marked is_error is reported as a failed tool call", () => {
		const converter = new EventConverter();
		const events = converter.push({
			type: "user",
			session_id: "11111111-2222-3333-4444-555555555555",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_abc",
						content: "File does not exist.",
						is_error: true,
					},
				],
			},
		});
		expect(events[0]).toMatchObject({
			kind: "tool-end",
			toolUseId: "toolu_abc",
			isError: true,
		});
	});

	test("rate-limit events carry the window the meter displays", () => {
		const converter = new EventConverter();
		const [event] = converter.push({
			type: "rate_limit_event",
			rate_limit_info: {
				status: "allowed",
				resetsAt: 1789494000,
				rateLimitType: "five_hour",
			},
		});
		expect(event).toMatchObject({
			kind: "rate-limit",
			status: "allowed",
			window: "five_hour",
			resetsAt: 1789494000,
		});
	});
});

/**
 * Synthetic, shaped after the SDK's own types: a subagent's messages carry the
 * `tool_use` id of the Task call that started it in `parent_tool_use_id`, and
 * the turn's context use lives in the top-level assistant `usage`.
 */
describe("EventConverter — subagents, context use and compaction", () => {
	const sub = (extra: object) => ({ type: "assistant", session_id: "s", parent_tool_use_id: "toolu_A", message: { content: [] }, ...extra });

	test("tool calls inside a subagent carry their parent", () => {
		const c = new EventConverter();
		const events = c.push(sub({ message: { content: [{ type: "tool_use", id: "toolu_B", name: "Read", input: { file_path: "x" } }] } }));
		expect(events).toEqual([{ kind: "tool-start", sessionId: "s", toolUseId: "toolu_B", name: "Read", input: { file_path: "x" }, parentToolUseId: "toolu_A" }]);
	});

	test("a subagent's tool result carries its parent too", () => {
		const c = new EventConverter();
		const events = c.push({ type: "user", session_id: "s", parent_tool_use_id: "toolu_A", message: { content: [{ type: "tool_result", tool_use_id: "toolu_B", content: "ok" }] } });
		expect(events).toEqual([{ kind: "tool-end", sessionId: "s", toolUseId: "toolu_B", isError: false, content: "ok", parentToolUseId: "toolu_A" }]);
	});

	test("top-level tool calls have no parent", () => {
		const c = new EventConverter();
		const events = c.push({ type: "assistant", session_id: "s", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_A", name: "Task", input: {} }] } });
		expect(events).toEqual([{ kind: "tool-start", sessionId: "s", toolUseId: "toolu_A", name: "Task", input: {}, parentToolUseId: null }]);
	});

	test("subagent prose is not the main answer", () => {
		const c = new EventConverter();
		const events = c.push(sub({ message: { content: [{ type: "text", text: "found it" }] } }));
		expect(events).toEqual([{ kind: "subagent-text", sessionId: "s", parentToolUseId: "toolu_A", text: "found it" }]);
	});

	test("subagent stream deltas are dropped", () => {
		const c = new EventConverter();
		expect(c.push({ type: "stream_event", session_id: "s", parent_tool_use_id: "toolu_A", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } } })).toEqual([]);
	});

	test("a subagent's stream does not swallow the main answer's completed text", () => {
		const c = new EventConverter();
		c.push({ type: "stream_event", session_id: "s", parent_tool_use_id: "toolu_A", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } } });
		const events = c.push({ type: "assistant", session_id: "s", parent_tool_use_id: null, message: { content: [{ type: "text", text: "done" }] } });
		expect(events).toEqual([{ kind: "text", sessionId: "s", text: "done" }]);
	});

	test("turn-end reports context use from the last top-level call", () => {
		const c = new EventConverter();
		c.push({ type: "system", subtype: "init", session_id: "s", model: "claude-opus-5-5", tools: [], slash_commands: [] });
		c.push({ type: "assistant", session_id: "s", parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000, output_tokens: 5 } } });
		const [end] = c.push({ type: "result", subtype: "success", session_id: "s", result: "ok", duration_ms: 1, num_turns: 1, total_cost_usd: 0.1, modelUsage: { "claude-opus-5-5": { contextWindow: 200000 }, "claude-haiku": { contextWindow: 100000 } } });
		expect(end).toMatchObject({ kind: "turn-end", context: { used: 42010, window: 200000 } });
	});

	test("a subagent's usage is not the session's context", () => {
		const c = new EventConverter();
		c.push({ type: "system", subtype: "init", session_id: "s", model: "claude-opus-5-5", tools: [], slash_commands: [] });
		c.push({ type: "assistant", session_id: "s", parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 1000 } } });
		c.push(sub({ message: { content: [], usage: { input_tokens: 90000 } } }));
		const [end] = c.push({ type: "result", subtype: "success", session_id: "s", modelUsage: { "claude-opus-5-5": { contextWindow: 200000 } } });
		expect(end).toMatchObject({ kind: "turn-end", context: { used: 1000, window: 200000 } });
	});

	test("without a model match the window is the largest one reported", () => {
		const c = new EventConverter();
		c.push({ type: "assistant", session_id: "s", parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 500 } } });
		const [end] = c.push({ type: "result", subtype: "success", session_id: "s", modelUsage: { "claude-sonnet": { contextWindow: 1000000 }, "claude-haiku": { contextWindow: 200000 } } });
		expect(end).toMatchObject({ kind: "turn-end", context: { used: 500, window: 1000000 } });
	});

	test("context is null when the usage or the window is unknown", () => {
		const noUsage = new EventConverter();
		expect(noUsage.push({ type: "result", subtype: "success", session_id: "s", modelUsage: { m: { contextWindow: 200000 } } })[0]).toMatchObject({ kind: "turn-end", context: null });

		const noWindow = new EventConverter();
		noWindow.push({ type: "assistant", session_id: "s", parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 500 } } });
		expect(noWindow.push({ type: "result", subtype: "success", session_id: "s" })[0]).toMatchObject({ kind: "turn-end", context: null });
	});

	test("compaction boundary", () => {
		const c = new EventConverter();
		expect(c.push({ type: "system", subtype: "compact_boundary", session_id: "s", compact_metadata: { trigger: "manual", pre_tokens: 150000, post_tokens: 20000 } })).toEqual([{ kind: "compacted", sessionId: "s", trigger: "manual", preTokens: 150000, postTokens: 20000 }]);
	});

	test("a compaction with no reported size after it has postTokens null", () => {
		const c = new EventConverter();
		expect(c.push({ type: "system", subtype: "compact_boundary", session_id: "s", compact_metadata: { trigger: "auto", pre_tokens: 150000 } })).toEqual([{ kind: "compacted", sessionId: "s", trigger: "auto", preTokens: 150000, postTokens: null }]);
	});

	// /compact ends its turn without a new assistant call; reporting the
	// pre-compaction figure would show the meter full right after emptying it.
	test("a turn that only compacted reports the size after compaction", () => {
		const c = new EventConverter();
		c.push({ type: "assistant", session_id: "s", parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 150000 } } });
		c.push({ type: "system", subtype: "compact_boundary", session_id: "s", compact_metadata: { trigger: "manual", pre_tokens: 150000, post_tokens: 20000 } });
		const [end] = c.push({ type: "result", subtype: "success", session_id: "s", modelUsage: { m: { contextWindow: 200000 } } });
		expect(end).toMatchObject({ kind: "turn-end", context: { used: 20000, window: 200000 } });
	});
});
