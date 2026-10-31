import { describe, expect, test } from "vitest";
import { DEFAULT_DOCK, DEFAULT_VIEW_ORDER, normalizeDock, normalizeViews } from "./dock.ts";

describe("normalizeDock", () => {
	test("nothing saved gives the familiar layout", () => {
		expect(normalizeDock(undefined)).toEqual(DEFAULT_DOCK);
		expect(DEFAULT_DOCK).toEqual({ left: ["explorer", "search", "git", "sessions"], right: ["chat"], bottom: ["terminal"] });
	});

	test("keeps a saved arrangement, each panel once, unknown ones dropped, missing ones put back home", () => {
		const dock = normalizeDock({ left: ["chat", "explorer", "chat", "nope"], right: ["terminal"], bottom: 7 });
		expect(dock).toEqual({ left: ["chat", "explorer", "search", "git", "sessions"], right: ["terminal"], bottom: [] });
	});

	test("a panel the window lost entirely goes back to its default area, even if that area is now empty", () => {
		expect(normalizeDock({ left: ["explorer", "search", "git", "sessions", "chat"], right: [], bottom: [] }).bottom).toEqual(["terminal"]);
	});
});

describe("normalizeViews", () => {
	test("order is a full permutation; Code cannot be hidden", () => {
		expect(normalizeViews(undefined, undefined)).toEqual({ order: DEFAULT_VIEW_ORDER, hidden: [] });
		expect(normalizeViews(["server", "code", "server", "x"], ["code", "brain", "brain", "y"])).toEqual({
			order: ["server", "code", "brain", "feed", "agents", "browser", "automations"],
			hidden: ["brain"],
		});
	});
});
