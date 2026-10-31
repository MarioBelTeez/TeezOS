import { describe, expect, test } from "vitest";
import { lastSeq, mergeEvents, runView } from "./runs-view.ts";

const note = (seq: number, text: string) => ({ seq, at: seq, data: { type: "runner", text } });

describe("runView", () => {
	test("draws the prompt and the runner's notes as cards of a finished chat", () => {
		const view = runView({ prompt: "Summarise the week" }, [note(0, "git pull: up to date")]);
		expect(view.cards).toEqual([
			{ id: "c1", kind: "user", text: "Summarise the week" },
			{ id: "c2", kind: "notice", text: "git pull: up to date" },
		]);
		expect(view.running).toBe(false);
	});
});

describe("run events", () => {
	test("merge in seq order without repeats, and know where to carry on", () => {
		const merged = mergeEvents([note(0, "a"), note(1, "b")], [note(1, "b"), note(3, "d"), note(2, "c")]);
		expect(merged.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
		expect(lastSeq(merged)).toBe(3);
		expect(lastSeq([])).toBe(-1);
	});
});
