import { describe, expect, test, vi } from "vitest";
import type { MenuItem } from "../state/ui.ts";
import { safeLink, universalItems, type MenuActions, type MenuTarget } from "./universal-menu.ts";

const target = (over: Partial<MenuTarget> = {}): MenuTarget => ({ editable: false, readOnly: false, selection: "", hasText: false, link: null, ...over });
const actions = (): MenuActions => ({
	undo: vi.fn(),
	redo: vi.fn(),
	cut: vi.fn(),
	copy: vi.fn(),
	paste: vi.fn(),
	selectAll: vi.fn(),
	openLink: vi.fn(),
	openLinkOutside: vi.fn(),
	back: vi.fn(),
	forward: vi.fn(),
	palette: vi.fn(),
	settings: vi.fn(),
});
const labels = (items: MenuItem[]): string[] => items.flatMap((i) => ("separator" in i ? [] : [i.label]));
const item = (items: MenuItem[], label: string) => items.find((i) => !("separator" in i) && i.label === label) as Extract<MenuItem, { label: string }>;

describe("universalItems", () => {
	test("an empty spot still gets a menu: navigation and the palette", () => {
		expect(labels(universalItems(target(), actions()))).toEqual(["Back", "Forward", "Command palette", "Settings"]);
	});

	test("selected page text adds Copy, which copies that text", () => {
		const a = actions();
		const items = universalItems(target({ selection: "hello" }), a);
		expect(labels(items)[0]).toBe("Copy");
		item(items, "Copy").onSelect();
		expect(a.copy).toHaveBeenCalledWith("hello");
	});

	test("a text field gets the editing commands; Cut and Copy need a selection", () => {
		const items = universalItems(target({ editable: true, hasText: true }), actions());
		expect(labels(items).slice(0, 6)).toEqual(["Undo", "Redo", "Cut", "Copy", "Paste", "Select all"]);
		expect(item(items, "Cut").disabled).toBe(true);
		expect(item(items, "Copy").disabled).toBe(true);
		expect(item(items, "Paste").disabled).toBe(false);
		const selected = universalItems(target({ editable: true, hasText: true, selection: "x" }), actions());
		expect(item(selected, "Cut").disabled).toBe(false);
	});

	test("a read-only field can be copied from but not changed", () => {
		const items = universalItems(target({ editable: true, readOnly: true, hasText: true, selection: "x" }), actions());
		expect(item(items, "Cut").disabled).toBe(true);
		expect(item(items, "Paste").disabled).toBe(true);
		expect(item(items, "Undo").disabled).toBe(true);
		expect(item(items, "Copy").disabled).toBe(false);
	});

	test("a link comes first, with open, open outside and copy", () => {
		const a = actions();
		const items = universalItems(target({ link: "https://belteez.com" }), a);
		expect(labels(items).slice(0, 3)).toEqual(["Open link", "Open in system browser", "Copy link address"]);
		item(items, "Open link").onSelect();
		expect(a.openLink).toHaveBeenCalledWith("https://belteez.com");
	});
});

describe("safeLink", () => {
	test("only http(s) links of sane length", () => {
		expect(safeLink("https://a.com")).toBe("https://a.com");
		expect(safeLink("file:///C:/x")).toBeNull();
		expect(safeLink("javascript:alert(1)")).toBeNull();
		expect(safeLink(`https://a.com/${"x".repeat(3000)}`)).toBeNull();
		expect(safeLink(null)).toBeNull();
	});
});
