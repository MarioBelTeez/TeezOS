import { afterEach, describe, expect, test } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { UiEvent } from "../claude/events.ts";
import { AgySubagentWatcher, parseSubagentLaunch, parseTranscriptLine, unwrapTranscriptArgs } from "./subagents.ts";

const waitFor = async (check: () => boolean): Promise<void> => {
	for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 15));
};

const tempDirs: string[] = [];
afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("parseSubagentLaunch", () => {
	const uuid = "a13636b6-c40a-48ce-ac93-768c17934781";

	test("extracts conversationId and converts logAbsoluteUri to a local path", () => {
		const expectedPath = join(tmpdir(), "subagent-test", "transcript.jsonl");
		const uri = pathToFileURL(expectedPath).href;
		const parsed = parseSubagentLaunch(JSON.stringify({ conversationId: uuid, logAbsoluteUri: uri }));
		expect(parsed).toEqual({ conversationId: uuid, logPath: expectedPath });
	});

	test("extracts JSON embedded in surrounding text", () => {
		const expectedPath = join(tmpdir(), "nested", "transcript.jsonl");
		const uri = pathToFileURL(expectedPath).href;
		const parsed = parseSubagentLaunch(`Subagent started:\n{"conversationId":"${uuid}","logAbsoluteUri":"${uri}"}\nDone.`);
		expect(parsed).toEqual({ conversationId: uuid, logPath: expectedPath });
	});

	test("falls back to the standard brain transcript path when logAbsoluteUri is absent or invalid", () => {
		const fallback = join(homedir(), ".gemini", "antigravity-cli", "brain", uuid, ".system_generated", "logs", "transcript.jsonl");
		expect(parseSubagentLaunch(JSON.stringify({ conversationId: uuid }))).toEqual({ conversationId: uuid, logPath: fallback });
		expect(parseSubagentLaunch(JSON.stringify({ conversationId: uuid, logAbsoluteUri: "not-a-file-uri" }))).toEqual({
			conversationId: uuid,
			logPath: fallback,
		});
	});

	test("returns null when no valid UUID conversationId is present", () => {
		expect(parseSubagentLaunch("")).toBeNull();
		expect(parseSubagentLaunch("Subagent failed to start")).toBeNull();
		expect(parseSubagentLaunch(JSON.stringify({ conversationId: "not-a-uuid" }))).toBeNull();
	});
});

describe("unwrapTranscriptArgs", () => {
	test("unwraps JSON-encoded strings, arrays, and objects while keeping plain values", () => {
		const unwrapped = unwrapTranscriptArgs({
			Path: '"C:\\\\Users\\\\rayan\\\\file.ts"',
			List: '["a","b"]',
			Nested: '{"ok":true}',
			Plain: "hello world",
			Broken: '"unterminated',
			Count: 42,
			Flag: true,
		});
		expect(unwrapped).toEqual({
			Path: "C:\\Users\\rayan\\file.ts",
			List: ["a", "b"],
			Nested: { ok: true },
			Plain: "hello world",
			Broken: '"unterminated',
			Count: 42,
			Flag: true,
		});
	});

	test("returns an empty object for non-object inputs", () => {
		expect(unwrapTranscriptArgs(null)).toEqual({});
		expect(unwrapTranscriptArgs("abc")).toEqual({});
		expect(unwrapTranscriptArgs([1, 2])).toEqual({});
	});
});

describe("parseTranscriptLine", () => {
	test("emits tool-start events with unwrapped args and deduplicates by step_index", () => {
		const seen = new Set<number>();
		const line = JSON.stringify({
			step_index: 2,
			type: "PLANNER_RESPONSE",
			status: "DONE",
			tool_calls: [
				{ name: "read_file", args: { Path: '"C:\\\\repo\\\\a.ts"' } },
				{ name: "run_command", args: { toolSummary: '"Run tests"', CommandLine: '"npx vitest"' } },
			],
		});

		const first = parseTranscriptLine(line, "parent#1", "sess-1", seen);
		expect(first.finished).toBe(false);
		expect(first.events).toEqual([
			{
				kind: "tool-start",
				sessionId: "sess-1",
				toolUseId: "parent#1:sub:2:0",
				name: "read_file",
				input: { Path: "C:\\repo\\a.ts" },
				parentToolUseId: "parent#1",
			},
			{
				kind: "tool-start",
				sessionId: "sess-1",
				toolUseId: "parent#1:sub:2:1",
				name: "run_command",
				input: { toolSummary: "Run tests", CommandLine: "npx vitest" },
				parentToolUseId: "parent#1",
			},
		]);

		expect(parseTranscriptLine(line, "parent#1", "sess-1", seen)).toEqual({ events: [], finished: false });
	});

	test("marks send_message as finished and emits subagent-text with the first line", () => {
		const seen = new Set<number>();
		const line = JSON.stringify({
			step_index: 5,
			type: "PLANNER_RESPONSE",
			status: "DONE",
			tool_calls: [{ name: "send_message", args: { Recipient: JSON.stringify("parent"), Message: JSON.stringify("\nAll tests pass.\nSecond line") } }],
		});

		const res = parseTranscriptLine(line, "parent#1", "sess-1", seen);
		expect(res.finished).toBe(true);
		expect(res.events).toEqual([
			{
				kind: "tool-start",
				sessionId: "sess-1",
				toolUseId: "parent#1:sub:5:0",
				name: "send_message",
				input: { Recipient: "parent", Message: "\nAll tests pass.\nSecond line" },
				parentToolUseId: "parent#1",
			},
			{
				kind: "subagent-text",
				sessionId: "sess-1",
				parentToolUseId: "parent#1",
				text: "All tests pass.",
			},
		]);
	});

	test("marks a DONE PLANNER_RESPONSE without tool_calls as finished when it has text", () => {
		const seen = new Set<number>();
		const line = JSON.stringify({
			step_index: 7,
			type: "PLANNER_RESPONSE",
			status: "DONE",
			response: "Summary complete.\nExtra details.",
		});

		const res = parseTranscriptLine(line, "parent#1", "sess-1", seen);
		expect(res.finished).toBe(true);
		expect(res.events).toEqual([
			{
				kind: "subagent-text",
				sessionId: "sess-1",
				parentToolUseId: "parent#1",
				text: "Summary complete.",
			},
		]);
	});

	test("ignores non-planner steps and malformed JSON", () => {
		const seen = new Set<number>();
		expect(parseTranscriptLine("not json", "p", "s", seen)).toEqual({ events: [], finished: false });
		expect(parseTranscriptLine(JSON.stringify({ step_index: 1, type: "GENERIC", status: "DONE", content: "hi" }), "p", "s", seen)).toEqual({
			events: [],
			finished: false,
		});
	});
});

describe("AgySubagentWatcher", () => {
	test("tails a transcript file from creation to send_message completion and closes child steps", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agy-subagent-test-"));
		tempDirs.push(dir);
		const logPath = join(dir, "transcript.jsonl");

		const events: UiEvent[] = [];
		let doneCalls = 0;
		const watcher = new AgySubagentWatcher({
			parentToolUseId: "sess#3",
			sessionId: "sess",
			logPath,
			pollMs: 15,
			onEvent: (e) => events.push(e),
			onDone: () => {
				doneCalls += 1;
			},
		});

		// File does not exist yet — wait a beat to confirm ENOENT is tolerated.
		await new Promise((r) => setTimeout(r, 40));
		expect(events).toEqual([]);

		// Step 1: read_file
		writeFileSync(
			logPath,
			`${JSON.stringify({
				step_index: 1,
				type: "PLANNER_RESPONSE",
				status: "DONE",
				tool_calls: [{ name: "read_file", args: { Path: '"src/index.ts"' } }],
			})}\n`,
		);
		await waitFor(() => events.some((e) => e.kind === "tool-start" && e.name === "read_file"));

		// Step 2: send_message (should close step 1, emit send_message + subagent-text, close send_message, emit parent tool-end)
		appendFileSync(
			logPath,
			`${JSON.stringify({
				step_index: 2,
				type: "PLANNER_RESPONSE",
				status: "DONE",
				tool_calls: [{ name: "send_message", args: { Recipient: JSON.stringify("parent"), Message: JSON.stringify("Implemented feature.\nDetails") } }],
			})}\n`,
		);

		await waitFor(() => doneCalls === 1);
		watcher.stop();

		expect(events).toEqual([
			{
				kind: "tool-start",
				sessionId: "sess",
				toolUseId: "sess#3:sub:1:0",
				name: "read_file",
				input: { Path: "src/index.ts" },
				parentToolUseId: "sess#3",
			},
			{
				kind: "tool-end",
				sessionId: "sess",
				toolUseId: "sess#3:sub:1:0",
				isError: false,
				content: "",
				parentToolUseId: "sess#3",
			},
			{
				kind: "tool-start",
				sessionId: "sess",
				toolUseId: "sess#3:sub:2:0",
				name: "send_message",
				input: { Recipient: "parent", Message: "Implemented feature.\nDetails" },
				parentToolUseId: "sess#3",
			},
			{
				kind: "subagent-text",
				sessionId: "sess",
				parentToolUseId: "sess#3",
				text: "Implemented feature.",
			},
			{
				kind: "tool-end",
				sessionId: "sess",
				toolUseId: "sess#3:sub:2:0",
				isError: false,
				content: "",
				parentToolUseId: "sess#3",
			},
			{
				kind: "tool-end",
				sessionId: "sess",
				toolUseId: "sess#3",
				isError: false,
				content: "Implemented feature.",
				parentToolUseId: null,
			},
		]);
		expect(doneCalls).toBe(1);
	});

	test("stop(true) closes open child tools and emits a cancelled parent tool-end", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agy-subagent-cancel-"));
		tempDirs.push(dir);
		const logPath = join(dir, "transcript.jsonl");
		writeFileSync(
			logPath,
			`${JSON.stringify({
				step_index: 1,
				type: "PLANNER_RESPONSE",
				status: "DONE",
				tool_calls: [{ name: "read_file", args: { Path: '"a.ts"' } }],
			})}\n`,
		);

		const events: UiEvent[] = [];
		let doneCalls = 0;
		const watcher = new AgySubagentWatcher({
			parentToolUseId: "sess#9",
			sessionId: "sess",
			logPath,
			pollMs: 15,
			onEvent: (e) => events.push(e),
			onDone: () => {
				doneCalls += 1;
			},
		});

		await waitFor(() => events.some((e) => e.kind === "tool-start"));
		watcher.stop(true);

		expect(events.at(-2)).toMatchObject({ kind: "tool-end", toolUseId: "sess#9:sub:1:0", isError: true, parentToolUseId: "sess#9" });
		expect(events.at(-1)).toMatchObject({ kind: "tool-end", toolUseId: "sess#9", isError: true, content: "Subagent cancelled.", parentToolUseId: null });
		expect(doneCalls).toBe(1);
	});
});
