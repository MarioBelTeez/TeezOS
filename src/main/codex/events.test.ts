import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { UiEvent } from "../claude/events.ts";
import { CodexEventConverter } from "./events.ts";

function replay(name: string): UiEvent[] {
	const lines = readFileSync(new URL(`./__fixtures__/${name}.ndjson`, import.meta.url), "utf8").split("\n").filter((l) => l.trim());
	let now = 1_000;
	const converter = new CodexEventConverter(() => "thread-1", () => (now += 10));
	const events: UiEvent[] = [];
	for (const line of lines) {
		const message = JSON.parse(line) as { method?: string; params?: unknown; id?: unknown };
		// Server requests (approvals) are the session's business, not the converter's.
		if (message.method && message.id === undefined) events.push(...converter.convert(message.method, message.params));
	}
	return events;
}

const of = <K extends UiEvent["kind"]>(events: UiEvent[], kind: K) => events.filter((e): e is Extract<UiEvent, { kind: K }> => e.kind === kind);

describe("CodexEventConverter", () => {
	test("a text turn streams deltas that add up to the answer, then ends once", () => {
		const events = replay("text-turn");
		const deltas = of(events, "text-delta").map((e) => e.text).join("");
		const texts = of(events, "text");
		expect(deltas).toBe("hi");
		expect(texts.map((e) => e.text)).toEqual(["hi"]);
		const ends = of(events, "turn-end");
		expect(ends).toHaveLength(1);
		expect(ends[0]!.text).toBe("hi");
		expect(ends[0]!.costUsd).toBe(0);
		expect(ends[0]!.context?.window).toBeGreaterThan(0);
	});

	test("an approved command becomes a Bash tool that succeeds", () => {
		const events = replay("command-approval");
		const start = of(events, "tool-start");
		expect(start).toHaveLength(1);
		expect(start[0]!.name).toBe("Bash");
		expect(String(start[0]!.input["command"])).toContain("echo hi > a.txt");
		const end = of(events, "tool-end");
		expect(end).toHaveLength(1);
		expect(end[0]!.toolUseId).toBe(start[0]!.toolUseId);
		expect(end[0]!.isError).toBe(false);
	});

	test("a declined command ends as an error, saying so", () => {
		const end = of(replay("command-declined"), "tool-end");
		expect(end).toHaveLength(1);
		expect(end[0]!.isError).toBe(true);
		expect(end[0]!.content).toMatch(/declined/i);
	});

	test("a file change becomes an Edit tool with its path and Codex's diff", () => {
		const start = of(replay("file-change-approval"), "tool-start");
		expect(start).toHaveLength(1);
		expect(start[0]!.name).toBe("Edit");
		expect(String(start[0]!.input["file_path"])).toMatch(/notes\.txt$/);
		expect(start[0]!.input["diff"]).toBe("hello\n");
	});

	test("an interrupted turn is a cancelled turn, not an answer", () => {
		const events = replay("interrupted");
		expect(of(events, "turn-cancelled")).toHaveLength(1);
		expect(of(events, "turn-end")).toHaveLength(0);
	});

	test("the usage cap raises one rate-limit event with its reset time in seconds", () => {
		const events = replay("rate-limited");
		expect(events).toEqual([{ kind: "rate-limit", sessionId: "thread-1", status: "rejected", window: "codex", resetsAt: 1796067944 }]);
	});

	test("ordinary per-turn usage updates raise no rate-limit event", () => {
		expect(of(replay("text-turn"), "rate-limit")).toHaveLength(0);
	});

	test("a failed turn and a final error notification become run-errors; a retrying one does not", () => {
		const converter = new CodexEventConverter(() => "thread-1", () => 0);
		expect(converter.convert("turn/completed", { threadId: "t", turn: { id: "u", status: "failed", items: [], error: { message: "model overloaded" } } })).toEqual([
			{ kind: "run-error", sessionId: "thread-1", reason: "codex-turn-failed", message: "model overloaded" },
		]);
		expect(converter.convert("error", { error: { message: "stream lost" }, willRetry: true, threadId: "t", turnId: "u" })).toEqual([]);
		expect(converter.convert("error", { error: { message: "stream lost" }, willRetry: false, threadId: "t", turnId: "u" })).toEqual([
			{ kind: "run-error", sessionId: "thread-1", reason: "codex-error", message: "stream lost" },
		]);
	});

	test("unknown methods and malformed known ones are ignored, never thrown", () => {
		const converter = new CodexEventConverter(() => "thread-1");
		expect(converter.convert("some/new/method", {})).toEqual([]);
		expect(converter.convert("item/started", {})).toEqual([]);
		expect(converter.convert("item/agentMessage/delta", null)).toEqual([]);
		expect(converter.convert("turn/completed", { turn: "nonsense" })).toEqual([]);
	});
});
