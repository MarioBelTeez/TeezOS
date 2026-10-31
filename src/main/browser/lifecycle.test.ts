import { describe, expect, test } from "vitest";
import { startsNewDocument } from "./lifecycle.ts";

describe("startsNewDocument", () => {
	test("a reload or new page in the app window's main frame starts over", () => {
		expect(startsNewDocument({ isMainFrame: true, isSameDocument: false })).toBe(true);
	});
	test("in-page navigation and subframes do not", () => {
		expect(startsNewDocument({ isMainFrame: true, isSameDocument: true })).toBe(false);
		expect(startsNewDocument({ isMainFrame: false, isSameDocument: false })).toBe(false);
	});
});
