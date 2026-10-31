import { describe, expect, test } from "vitest";
import { placeAbove, placeMenu } from "./place-menu.ts";

const viewport = { width: 1000, height: 800 };
const size = { width: 200, height: 150 };

describe("placeMenu", () => {
	test("fits below: opens at the point", () => {
		expect(placeMenu({ x: 100, y: 100 }, size, viewport)).toEqual({ left: 100, top: 100 });
	});

	test("overflows the bottom: flips to sit directly above the anchor", () => {
		expect(placeMenu({ x: 100, y: 760, anchorTop: 730 }, size, viewport)).toEqual({ left: 100, top: 730 - 150 });
	});

	test("overflows the bottom with no anchor: opens upward from the point", () => {
		expect(placeMenu({ x: 100, y: 760 }, size, viewport)).toEqual({ left: 100, top: 760 - 150 });
	});

	test("overflows the right: shifted left to stay on screen", () => {
		const { left } = placeMenu({ x: 950, y: 100 }, size, viewport);
		expect(left + size.width).toBeLessThanOrEqual(viewport.width);
		expect(left).toBe(1000 - 200 - 6);
	});

	test("never negative, even when the menu is bigger than the room", () => {
		expect(placeMenu({ x: 50, y: 60, anchorTop: 40 }, { width: 2000, height: 1000 }, viewport)).toEqual({ left: 0, top: 0 });
	});

	test("too tall for above or below: keeps as much on screen as it can", () => {
		const { top } = placeMenu({ x: 0, y: 500, anchorTop: 100 }, { width: 100, height: 700 }, viewport);
		expect(top).toBeGreaterThanOrEqual(0);
		expect(top + 700).toBeLessThanOrEqual(viewport.height);
	});
});

describe("placeAbove", () => {
	test("sits just above the composer, even with room below it", () => {
		expect(placeAbove({ left: 100, top: 300 }, size, viewport)).toEqual({ left: 100, top: 300 - 4 - 150 });
	});

	test("no room above: stays on screen", () => {
		const { top } = placeAbove({ left: 100, top: 60 }, size, viewport);
		expect(top).toBeGreaterThanOrEqual(0);
		expect(top + size.height).toBeLessThanOrEqual(viewport.height);
	});

	test("pulled left to stay on screen", () => {
		const { left } = placeAbove({ left: 950, top: 700 }, size, viewport);
		expect(left + size.width).toBeLessThanOrEqual(viewport.width);
	});
});
