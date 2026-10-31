import { describe, expect, test } from "vitest";
import { buildHandover } from "./handover.ts";
import type { Card } from "./reduce.ts";

const user = (id: number, text: string): Card => ({ id: `c${id}`, kind: "user", text });
const answer = (id: number, text: string): Card => ({ id: `c${id}`, kind: "assistant", text });
const tool = (id: number, name: string, input: Record<string, unknown>): Card => ({
	id: `c${id}`,
	kind: "tool",
	toolUseId: `t${id}`,
	name,
	input,
	status: "done",
	result: "a long result that the hand-over leaves out",
});

describe("buildHandover", () => {
	test("empty chat gives nothing", () => {
		expect(buildHandover([], "Claude", "t")).toBe("");
	});

	test("a chat with only tool calls and notices gives nothing", () => {
		const cards: Card[] = [tool(1, "Read", { file_path: "a.ts" }), { id: "c2", kind: "notice", text: "Model: opus" }];
		expect(buildHandover(cards, "Claude", "t")).toBe("");
	});

	test("header, then the conversation in order", () => {
		const out = buildHandover([user(1, "fix the bug"), answer(2, "Fixed in x.ts")], "Claude", "Bugfix");
		expect(out.split("\n")[0]).toBe("Context from the Claude chat «Bugfix»:");
		expect(out.indexOf("fix the bug")).toBeLessThan(out.indexOf("Fixed in x.ts"));
	});

	test("tool calls are one line each, without their results", () => {
		const out = buildHandover([user(1, "read it"), tool(2, "Read", { file_path: "src/a.ts" }), answer(3, "done")], "Claude", "t");
		expect(out).toContain("- Read: src/a.ts");
		expect(out).not.toContain("a long result");
	});

	test("turn footers, notices and errors are left out", () => {
		const cards: Card[] = [
			user(1, "go"),
			{ id: "c2", kind: "turn", durationMs: 1000, costUsd: 0.5 },
			{ id: "c3", kind: "error", reason: "sdk-error", text: "boom" },
		];
		const out = buildHandover(cards, "Claude", "t");
		expect(out).not.toContain("boom");
		expect(out).not.toContain("0.5");
	});

	test("long messages are cut to 600 chars and the whole to 6000", () => {
		const cards = Array.from({ length: 30 }, (_, i) => user(i, "y".repeat(2000)));
		const out = buildHandover(cards, "Claude", "t");
		expect(out.length).toBeLessThanOrEqual(6000);
		expect(out).toContain("…");
		expect(out).not.toContain("y".repeat(601));
	});

	test("the oldest entries go first when over the cap", () => {
		const cards = Array.from({ length: 12 }, (_, i) => user(i, `m${String(i).padStart(2, "0")} ${"y".repeat(700)}`));
		const out = buildHandover(cards, "Claude", "t");
		expect(out).not.toContain("m00 ");
		expect(out).toContain("m11 ");
	});

	test("only the last 12 cards count", () => {
		const cards = Array.from({ length: 20 }, (_, i) => user(i, `msg-${i}`));
		const out = buildHandover(cards, "Claude", "t");
		expect(out).not.toContain("msg-7");
		expect(out).toContain("msg-8");
	});
});
