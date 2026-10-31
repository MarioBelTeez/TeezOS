import { describe, expect, test } from "vitest";
import { isReaderScroll, stickAfterChatChange, stickAfterScroll } from "./scroll.ts";

describe("stickAfterChatChange", () => {
	test("opening a chat for the first time starts at the bottom", () => {
		expect(stickAfterChatChange(null, "a", false)).toBe(true);
	});

	test("switching to another chat starts at the bottom, wherever the last one was left", () => {
		expect(stickAfterChatChange("a", "b", false)).toBe(true);
	});

	test("new output in the same chat keeps wherever the reader scrolled to", () => {
		expect(stickAfterChatChange("a", "a", false)).toBe(false);
		expect(stickAfterChatChange("a", "a", true)).toBe(true);
	});
});

describe("stickAfterScroll", () => {
	test("the reader scrolling up stops following; back to the bottom follows again", () => {
		expect(stickAfterScroll({ stick: true, atBottom: false, byReader: true, movedUp: true })).toBe(false);
		expect(stickAfterScroll({ stick: false, atBottom: true, byReader: true, movedUp: false })).toBe(true);
	});

	test("a scroll the reader did not make (layout, scroll anchoring, a hidden panel) never stops following", () => {
		expect(stickAfterScroll({ stick: true, atBottom: false, byReader: false, movedUp: true })).toBe(true);
	});

	test("the app's own downward follow-scroll right after a click never stops following", () => {
		// e.g. Copy or Approve clicked, then a big card lands: not at the bottom yet, but moving down
		expect(stickAfterScroll({ stick: true, atBottom: false, byReader: true, movedUp: false })).toBe(true);
	});

	test("landing at the bottom by any means follows again", () => {
		expect(stickAfterScroll({ stick: false, atBottom: true, byReader: false, movedUp: false })).toBe(true);
		expect(stickAfterScroll({ stick: false, atBottom: false, byReader: false, movedUp: false })).toBe(false);
	});
});

describe("isReaderScroll", () => {
	test("only a recent wheel, touch, key or pointer input counts as the reader's", () => {
		expect(isReaderScroll(1_000, 1_500)).toBe(true);
		expect(isReaderScroll(1_000, 2_500)).toBe(false);
		expect(isReaderScroll(null, 2_500)).toBe(false);
	});
});
