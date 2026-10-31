import { describe, expect, it } from "vitest";
import {
	MAX_DESKS,
	MAX_GRID_CHARS,
	closeDesk,
	deskTitle,
	firstLayout,
	insertDesk,
	normalizeDesks,
	placementFor,
	renameDesk,
	reorderDesks,
	type Desk,
	type PanelKind,
} from "./desks.ts";

const desk = (id: string, workspaceId = "w1", name = ""): Desk => ({ id, name, workspaceId, grid: null });
const ids = (desks: readonly Desk[]): string[] => desks.map((d) => d.id);

describe("normalizeDesks", () => {
	it("starts one desk on the active workspace when nothing was saved", () => {
		expect(normalizeDesks(undefined, undefined, ["w1"], "w1")).toEqual({
			desks: [{ id: "desk-1", name: "", workspaceId: "w1", grid: null }],
			activeDeskId: "desk-1",
		});
	});

	it("closes a desk whose project was unpinned and gives a project-less desk the active one", () => {
		const { desks } = normalizeDesks([desk("a", "gone"), desk("b", ""), desk("c", "w2")], "a", ["w1", "w2"], "w1");
		expect(desks.map((d) => [d.id, d.workspaceId])).toEqual([["b", "w1"], ["c", "w2"]]);
	});

	it("falls back to the first desk when the active one is gone", () => {
		expect(normalizeDesks([desk("a"), desk("b")], "zzz", ["w1"], "w1").activeDeskId).toBe("a");
	});

	it("drops bad and duplicate ids, trims names and caps the count", () => {
		const many = Array.from({ length: MAX_DESKS + 3 }, (_, i) => desk(`d${i}`));
		const { desks } = normalizeDesks([desk("bad id!"), desk("d0", "w1", `  ${"x".repeat(80)}  `), ...many], "d0", ["w1"], "w1");
		expect(desks).toHaveLength(MAX_DESKS);
		expect(desks[0]?.name).toHaveLength(40);
		expect(new Set(ids(desks)).size).toBe(MAX_DESKS);
	});

	it("keeps a grid object and drops one that is not an object or is oversized", () => {
		const big = { blob: "x".repeat(MAX_GRID_CHARS) };
		const { desks } = normalizeDesks(
			[{ ...desk("a"), grid: { grid: {} } }, { ...desk("b"), grid: "nope" }, { ...desk("c"), grid: big }],
			"a",
			["w1"],
			"w1",
		);
		expect(desks.map((d) => d.grid)).toEqual([{ grid: {} }, null, null]);
	});
});

describe("desk operations", () => {
	const three = [desk("a"), desk("b"), desk("c")];

	it("closing the active desk hands over to the one beside it", () => {
		expect(closeDesk(three, "b", "b")).toEqual({ desks: [desk("a"), desk("c")], activeDeskId: "c" });
		expect(closeDesk(three, "c", "c").activeDeskId).toBe("b");
		expect(closeDesk(three, "a", "c")).toEqual({ desks: [desk("b"), desk("c")], activeDeskId: "c" });
	});

	it("never closes the last desk", () => {
		expect(closeDesk([desk("a")], "a", "a")).toEqual({ desks: [desk("a")], activeDeskId: "a" });
	});

	it("inserts after a desk, or at the end", () => {
		expect(ids(insertDesk(three, desk("n"), "a"))).toEqual(["a", "n", "b", "c"]);
		expect(ids(insertDesk(three, desk("n"), null))).toEqual(["a", "b", "c", "n"]);
	});

	it("reorders by drop side", () => {
		expect(ids(reorderDesks(three, "c", "a", false))).toEqual(["c", "a", "b"]);
		expect(ids(reorderDesks(three, "a", "c", true))).toEqual(["b", "c", "a"]);
		expect(ids(reorderDesks(three, "a", "a", true))).toEqual(["a", "b", "c"]);
	});

	it("renames, and an empty name falls back to the project's", () => {
		const renamed = renameDesk(three, "b", "  Site fixes  ");
		expect(renamed[1]?.name).toBe("Site fixes");
		expect(deskTitle(renameDesk(renamed, "b", " ")[1] as Desk, [{ id: "w1", name: "teezai" }])).toBe("teezai");
	});
});

describe("placementFor", () => {
	const having = (...panels: PanelKind[]) => (p: PanelKind): boolean => panels.includes(p);

	it("puts a side panel with the other side panels, wherever they were moved", () => {
		expect(placementFor("git", having("editor", "explorer"))).toEqual({ direction: "within", reference: "explorer" });
		expect(placementFor("git", having("editor"))).toEqual({ direction: "left" });
	});

	it("opens Brain, Server and Automations as tabs beside the editor", () => {
		expect(placementFor("brain", having("editor", "chat"))).toEqual({ direction: "within", reference: "editor" });
		expect(placementFor("editor", having("server"))).toEqual({ direction: "within", reference: "server" });
		expect(placementFor("server", having())).toBeNull();
	});

	it("chat goes right and the terminal along the bottom", () => {
		expect(placementFor("chat", having("editor"))).toEqual({ direction: "right" });
		expect(placementFor("terminal", having("editor"))).toEqual({ direction: "below" });
	});
});

describe("firstLayout", () => {
	it("rebuilds the 0.2.3 dock: editor, then each open area on its edge", () => {
		const steps = firstLayout(
			{ left: ["explorer", "git"], right: ["chat"], bottom: ["terminal"] },
			{ left: true, right: true, bottom: true },
			{ left: 300, right: 500, bottom: 200 },
		);
		expect(steps).toEqual([
			{ panel: "editor", placement: null, inactive: false },
			{ panel: "explorer", placement: { direction: "left" }, inactive: false, width: 300 },
			{ panel: "git", placement: { direction: "within", reference: "explorer" }, inactive: true },
			{ panel: "chat", placement: { direction: "right" }, inactive: false, width: 500 },
			{ panel: "terminal", placement: { direction: "below" }, inactive: false, height: 200 },
		]);
	});

	it("leaves out a closed or empty area", () => {
		const steps = firstLayout({ left: ["explorer", "chat"], right: [], bottom: ["terminal"] }, { left: true, right: true, bottom: false });
		expect(steps.map((s) => s.panel)).toEqual(["editor", "explorer", "chat"]);
	});
});
