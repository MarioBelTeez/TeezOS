import { describe, expect, test } from "vitest";
import { isBrowserText, isTabId, parseRect } from "./validate.ts";

describe("isTabId", () => {
	test("lowercase letters, digits and dashes, up to 40", () => {
		expect(isTabId("bt-lx2k9a3f")).toBe(true);
		expect(isTabId("perm-12")).toBe(true);
		for (const bad of ["", "A", "a/b", "../x", "a b", "x".repeat(41), 5, null, undefined]) expect(isTabId(bad)).toBe(false);
	});
});

describe("isBrowserText", () => {
	test("strings up to 2048 characters", () => {
		expect(isBrowserText("https://a.com")).toBe(true);
		expect(isBrowserText("x".repeat(2048))).toBe(true);
		expect(isBrowserText("x".repeat(2049))).toBe(false);
		expect(isBrowserText(42)).toBe(false);
	});
});

describe("parseRect", () => {
	test("null hides, four finite non-negative numbers place", () => {
		expect(parseRect(null)).toBeNull();
		expect(parseRect({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
	});
	test("anything else is refused", () => {
		for (const bad of [undefined, "rect", [1, 2, 3, 4], { x: 1, y: 2, width: 3 }, { x: -1, y: 0, width: 1, height: 1 }, { x: Number.NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 }, { x: 0, y: 0, width: 1e9, height: 1 }, { x: "1", y: 0, width: 1, height: 1 }]) {
			expect(parseRect(bad)).toBeUndefined();
		}
	});
});
