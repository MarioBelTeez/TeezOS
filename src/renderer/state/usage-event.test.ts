import { describe, expect, test } from "vitest";
import { claudeUsageOf } from "./usage-event.ts";

const limit = { kind: "rate-limit" as const, sessionId: "s", status: "rejected", window: "five_hour", resetsAt: 100 };

describe("claudeUsageOf", () => {
	test("a Claude chat's rate-limit event updates Claude's meter", () => {
		expect(claudeUsageOf(limit, "claude", 5)).toEqual({ status: "rejected", window: "five_hour", resetsAt: 100, seenAt: 5 });
	});
	test("Codex's and Antigravity's limits never touch Claude's meter", () => {
		expect(claudeUsageOf({ ...limit, window: "codex" }, "codex", 5)).toBeNull();
		expect(claudeUsageOf(limit, "agy", 5)).toBeNull();
		expect(claudeUsageOf(limit, undefined, 5)).toBeNull();
	});
	test("other events are not usage", () => {
		expect(claudeUsageOf({ kind: "text", sessionId: "s", text: "hi" }, "claude", 5)).toBeNull();
	});
});
