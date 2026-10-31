import { describe, expect, test } from "vitest";
import { gridPanelCount, shouldSaveGrid } from "./grid-save.ts";

const leaf = (views: string[]) => ({ type: "leaf", data: { views, id: "1" } });
const panels = { chat: { id: "chat" }, brain: { id: "brain" } };
const full = { grid: { root: { type: "branch", data: [leaf(["chat"]), leaf(["brain"])] } }, panels };
const empty = { grid: { root: { type: "branch", data: [leaf([])] } }, panels: {} };
/** What a dockview being torn down serializes to: its panels still listed, its groups already empty. */
const tornDown = { grid: { root: { type: "branch", data: [leaf([])] } }, panels };

describe("gridPanelCount", () => {
	test("counts the views placed in the grid's groups", () => {
		expect(gridPanelCount(full)).toBe(2);
		expect(gridPanelCount(empty)).toBe(0);
	});

	test("a torn-down grid counts as empty even though it still lists panels", () => {
		expect(gridPanelCount(tornDown)).toBe(0);
	});

	test("floating groups count too", () => {
		expect(gridPanelCount({ ...empty, floatingGroups: [{ data: { views: ["terminal"] } }] })).toBe(1);
	});

	test("anything unreadable counts as no panels", () => {
		expect(gridPanelCount(null)).toBe(0);
		expect(gridPanelCount("grid")).toBe(0);
		expect(gridPanelCount({ grid: { root: { type: "leaf", data: { views: "x" } } } })).toBe(0);
	});
});

describe("shouldSaveGrid", () => {
	test("a let-go attachment never saves", () => {
		expect(shouldSaveGrid({ disposed: true, detaching: false, grid: full, previous: full })).toBe(false);
		expect(shouldSaveGrid({ disposed: true, detaching: true, grid: full, previous: empty })).toBe(false);
	});

	test("on the way out, an empty grid never replaces a saved layout", () => {
		expect(shouldSaveGrid({ disposed: false, detaching: true, grid: empty, previous: full })).toBe(false);
		expect(shouldSaveGrid({ disposed: false, detaching: true, grid: tornDown, previous: full })).toBe(false);
	});

	test("on the way out, a real grid is saved", () => {
		expect(shouldSaveGrid({ disposed: false, detaching: true, grid: full, previous: empty })).toBe(true);
		expect(shouldSaveGrid({ disposed: false, detaching: true, grid: empty, previous: null })).toBe(true);
	});

	test("a live desk saves whatever it shows, an emptied desk too", () => {
		expect(shouldSaveGrid({ disposed: false, detaching: false, grid: empty, previous: full })).toBe(true);
		expect(shouldSaveGrid({ disposed: false, detaching: false, grid: full, previous: full })).toBe(true);
	});
});
