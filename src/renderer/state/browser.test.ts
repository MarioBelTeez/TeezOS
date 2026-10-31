import { afterEach, describe, expect, test, vi } from "vitest";
import { viewBounds } from "./browser.ts";

describe("viewBounds", () => {
	const rect = { x: 10.4, y: 20.6, width: 800.2, height: 600.7 } as DOMRect;
	test("rounded when visible and nothing covers it", () => {
		expect(viewBounds(rect, { visible: true, overlay: false })).toEqual({ x: 10, y: 21, width: 800, height: 601 });
	});
	test("hidden while a menu, palette, popover or Settings is open", () => {
		expect(viewBounds(rect, { visible: true, overlay: true })).toBeNull();
	});
	test("hidden when the panel is not visible or has no size", () => {
		expect(viewBounds(rect, { visible: false, overlay: false })).toBeNull();
		expect(viewBounds({ x: 0, y: 0, width: 0, height: 0 } as DOMRect, { visible: true, overlay: false })).toBeNull();
		expect(viewBounds(null, { visible: true, overlay: false })).toBeNull();
	});
});

import { activeAfterClose, coveredBy, missingPins, pinUrlOf, useBrowser, type BrowserTab } from "./browser.ts";
import { MAX_BROWSER_TABS } from "../../shared/modules.ts";

const tab = (id: string, url: string, pinned = false): BrowserTab => ({ id, url, title: "", favicon: null, loading: false, canGoBack: false, canGoForward: false, zoom: 100, pin: pinned ? url : null });

describe("activeAfterClose", () => {
	const tabs = [tab("a", "https://a.com"), tab("b", "https://b.com"), tab("c", "https://c.com")];
	test("closing the active tab picks its right neighbour, else its left", () => {
		expect(activeAfterClose(tabs, "b", "b")).toBe("c");
		expect(activeAfterClose(tabs, "c", "c")).toBe("b");
		expect(activeAfterClose([tab("a", "x")], "a", "a")).toBeNull();
	});
	test("closing another tab keeps the active one", () => {
		expect(activeAfterClose(tabs, "a", "c")).toBe("c");
	});
});

describe("missingPins", () => {
	test("pins without a pinned tab of the same url", () => {
		const pins = [{ title: "Mail", url: "https://privateemail.com" }, { title: "Site", url: "https://example.com" }];
		expect(missingPins([tab("a", "https://privateemail.com", true)], pins)).toEqual([pins[1]]);
		expect(missingPins([tab("a", "https://example.com", false)], pins)).toEqual(pins);
	});
	test("a pinned tab that navigated away still counts as its pin", () => {
		const moved = { ...tab("a", "https://privateemail.com", true), url: "https://privateemail.com/appsuite/" };
		expect(missingPins([moved], [{ title: "Mail", url: "https://privateemail.com" }])).toEqual([]);
	});
});

describe("coveredBy", () => {
	const base = { palette: "closed", menu: null, view: "desk", composerMenu: null, dialog: null, toasts: [] } as const;
	test("nothing open: not covered", () => {
		expect(coveredBy(base)).toBe(false);
	});
	test("palette, menu, Settings or a composer popover cover the page", () => {
		expect(coveredBy({ ...base, palette: "commands" })).toBe(true);
		expect(coveredBy({ ...base, menu: { x: 0, y: 0, items: [] } })).toBe(true);
		expect(coveredBy({ ...base, view: "settings" })).toBe(true);
		expect(coveredBy({ ...base, composerMenu: "model" })).toBe(true);
	});
	test("a dialog or a visible toast covers the page, so neither is drawn under it", () => {
		expect(coveredBy({ ...base, dialog: "skill-review" })).toBe(true);
		expect(coveredBy({ ...base, toasts: [{ id: 1, text: "Saved.", tone: "success" }] })).toBe(true);
	});
});

describe("pinUrlOf", () => {
	test("a pin keeps the origin and path, never the query or hash", () => {
		expect(pinUrlOf("https://mail.example/inbox?session=SECRET#msg-1")).toBe("https://mail.example/inbox");
		expect(pinUrlOf("https://privateemail.com")).toBe("https://privateemail.com/");
		expect(pinUrlOf("about:blank")).toBeNull();
		expect(pinUrlOf("not a url")).toBeNull();
	});
});

describe("useBrowser", () => {
	afterEach(() => {
		useBrowser.getState().reset();
		vi.unstubAllGlobals();
	});
	const stubBridge = () => {
		const create = vi.fn();
		vi.stubGlobal("window", { teez: { browser: { create, close: vi.fn(), stopFind: vi.fn(), answerPermission: vi.fn() } } });
		return create;
	};
	test("no tab past the limit: the strip never shows one the main process refused", () => {
		const create = stubBridge();
		for (let i = 0; i < MAX_BROWSER_TABS; i += 1) expect(useBrowser.getState().openTab(`https://x${i}.com`)).not.toBeNull();
		expect(useBrowser.getState().openTab("https://one-more.com")).toBeNull();
		expect(useBrowser.getState().tabs.length).toBe(MAX_BROWSER_TABS);
		expect(create).toHaveBeenCalledTimes(MAX_BROWSER_TABS);
	});
	test("reset forgets every tab and lets the pins open again", () => {
		stubBridge();
		useBrowser.getState().openTab("https://a.com");
		useBrowser.setState({ pinsOpened: true });
		useBrowser.getState().reset();
		expect(useBrowser.getState().tabs).toEqual([]);
		expect(useBrowser.getState().activeId).toBeNull();
		expect(useBrowser.getState().pinsOpened).toBe(false);
	});
});
