import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgyEventConverter } from "./events.ts";
import type { UiEvent } from "../claude/events.ts";

/** Runs recorded from agy 1.3.2 on this machine, 2026-10-10. */
function replay(name: string): UiEvent[] {
	const raw = readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8");
	const converter = new AgyEventConverter({ model: "gemini-3.8-flash-medium" });
	return raw
		.split(/\r?\n/)
		.filter(Boolean)
		.flatMap((line) => converter.push(JSON.parse(line)));
}

describe("AgyEventConverter", () => {
	test("a read: session, tool start and end, streamed text, turn end", () => {
		const events = replay("read-file.ndjson");
		expect(events.map((e) => e.kind)).toEqual([
			"session-ready",
			"tool-start",
			"tool-end",
			"text-delta",
			"text-delta",
			"turn-end",
		]);
		expect(events[0]).toMatchObject({
			kind: "session-ready",
			sessionId: "ad3c6521-3677-4761-b77a-7e57011a5563",
			model: "gemini-3.8-flash-medium",
			permissionMode: "request-review",
		});
		expect(events[1]).toMatchObject({ kind: "tool-start", name: "view_file", toolUseId: "ad3c6521-3677-4761-b77a-7e57011a5563#2" });
		expect(events[2]).toMatchObject({ kind: "tool-end", toolUseId: "ad3c6521-3677-4761-b77a-7e57011a5563#2", isError: false, content: "2 lines, 6 bytes" });
		expect(events.filter((e) => e.kind === "text-delta").map((e) => (e.kind === "text-delta" ? e.text : "")).join("")).toBe("hello\n");
		expect(events.at(-1)).toMatchObject({ kind: "turn-end", durationMs: 5068, costUsd: 0, context: { used: 12957, window: 1_000_000 } });
	});

	test("a refused command: the tool fails with the reason, then the chat is told why", () => {
		const events = replay("denied-command.ndjson");
		const toolEnd = events.find((e) => e.kind === "tool-end");
		expect(toolEnd).toMatchObject({ isError: true });
		expect(toolEnd?.kind === "tool-end" && toolEnd.content).toContain("user denied permission");
		const denied = events.find((e) => e.kind === "run-error");
		expect(denied).toMatchObject({ kind: "run-error", reason: "agy-denied" });
		expect(denied?.kind === "run-error" && denied.message).toContain("RunCommand");
	});

	test("a failed run becomes an error with agy's own message", () => {
		const converter = new AgyEventConverter({ model: "" });
		const events = converter.push({
			event: "result",
			result: { conversation_id: "c", status: "ERROR", response: "", error: "quota exhausted", duration_seconds: 0 },
		});
		expect(events).toEqual([{ kind: "run-error", sessionId: "c", reason: "agy-error", message: "quota exhausted" }]);
	});

	test("unknown events are ignored, not thrown on", () => {
		const converter = new AgyEventConverter({ model: "" });
		expect(converter.push({ event: "something_new", x: 1 })).toEqual([]);
		expect(converter.push("garbage")).toEqual([]);
	});
});
