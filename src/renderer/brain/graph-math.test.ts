import { describe, expect, test } from "vitest";
import { approach, folderColor, graphLabelAlpha, inertiaStep, labelAlpha, nodeRadius, zoomAround } from "./graph-math.ts";

describe("graphLabelAlpha", () => {
	const plain = { hovered: false, neighbour: false, current: false, compact: false, k: 1, mode: "zoom" as const, nodeAlpha: 1 };
	test("the current note's label always shows, whatever the zoom or mode", () => {
		for (const mode of ["zoom", "never", "always"] as const) {
			expect(graphLabelAlpha({ ...plain, current: true, mode, k: 0.2 })).toBe(1);
			expect(graphLabelAlpha({ ...plain, current: true, compact: true, mode, k: 0.2 })).toBe(1);
		}
	});
	test("hovered and its neighbours always show", () => {
		expect(graphLabelAlpha({ ...plain, hovered: true, k: 0.2 })).toBe(1);
		expect(graphLabelAlpha({ ...plain, neighbour: true, compact: true, k: 0.2 })).toBe(1);
	});
	test("the compact local graph shows other labels only zoomed in past 1.8", () => {
		expect(graphLabelAlpha({ ...plain, compact: true, k: 1.5 })).toBe(0);
		expect(graphLabelAlpha({ ...plain, compact: true, k: 1.9 })).toBe(1);
		expect(graphLabelAlpha({ ...plain, compact: true, k: 1.9, nodeAlpha: 0.15 })).toBeCloseTo(0.15);
		expect(graphLabelAlpha({ ...plain, compact: true, k: 3, mode: "never" })).toBe(0);
	});
	test("the full graph follows the label setting, faded with its node", () => {
		expect(graphLabelAlpha({ ...plain, k: 0.5 })).toBe(0);
		expect(graphLabelAlpha({ ...plain, k: 1.5, nodeAlpha: 0.5 })).toBeCloseTo(0.5);
		expect(graphLabelAlpha({ ...plain, k: 0.5, mode: "always" })).toBe(1);
	});
});

describe("graph maths", () => {
	test("radius grows with links, slowly", () => {
		expect(nodeRadius(0)).toBe(3);
		expect(nodeRadius(4)).toBeCloseTo(6.2);
	});
	test("colour by top folder, fallback for the rest", () => {
		expect(folderColor("brain/Gotchas.md")).toBe("#ff1744");
		expect(folderColor("Home.md")).toBe("#b8a9b0");
	});
	test("labels fade in with zoom", () => {
		expect(labelAlpha(0.5, "zoom")).toBe(0);
		expect(labelAlpha(1.0, "zoom")).toBeCloseTo(0.5);
		expect(labelAlpha(2, "zoom")).toBe(1);
		expect(labelAlpha(0.1, "always")).toBe(1);
		expect(labelAlpha(5, "never")).toBe(0);
	});
	test("approach moves toward the target and never overshoots", () => {
		const v = approach(0, 1, 10, 0.016);
		expect(v).toBeGreaterThan(0);
		expect(v).toBeLessThan(1);
	});
	test("inertia decays and stops", () => {
		expect(inertiaStep({ x: 10, y: 0 }, 16.67).x).toBeCloseTo(9);
		expect(inertiaStep({ x: 0.005, y: 0 }, 16.67)).toEqual({ x: 0, y: 0 });
	});
	test("zooming keeps the point under the cursor still", () => {
		const view = { x: 0, y: 0, k: 1 };
		const cursor = { x: 100, y: 50 };
		const next = zoomAround(view, cursor, 2);
		const worldBefore = { x: (cursor.x - view.x) / view.k, y: (cursor.y - view.y) / view.k };
		const worldAfter = { x: (cursor.x - next.x) / next.k, y: (cursor.y - next.y) / next.k };
		expect(worldAfter.x).toBeCloseTo(worldBefore.x);
		expect(worldAfter.y).toBeCloseTo(worldBefore.y);
		expect(zoomAround(view, cursor, 50).k).toBe(6);
	});
});
