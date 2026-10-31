import { describe, expect, test } from "vitest";
import { PANEL_MODULE, VIEW_IDS, enabledViews, panelEnabled, unhideModuleViews } from "./views.ts";
import { PANEL_KINDS } from "./desks.ts";
import { DEFAULT_MODULES, mergeModules } from "./modules.ts";
import { normalizeViews } from "./dock.ts";

test("all seven views, code first", () => {
	expect(VIEW_IDS).toEqual(["code", "brain", "feed", "agents", "browser", "server", "automations"]);
});
test("disabled modules leave the bar; code always stays", () => {
	expect(enabledViews([...VIEW_IDS], (m) => m !== "browser" && m !== "editor")).toEqual(["code", "brain", "feed", "agents", "server", "automations"]);
});
test("an old saved order gains the new views", () => {
	const { order } = normalizeViews(["automations", "code", "brain", "server"], []);
	expect(order).toEqual(expect.arrayContaining(["feed", "agents", "browser"]));
	expect(order.slice(0, 4)).toEqual(["automations", "code", "brain", "server"]);
});

test("turning a module on takes its view out of the hidden list; others stay hidden", () => {
	expect(unhideModuleViews(["server", "brain"], "server")).toEqual(["brain"]);
	expect(unhideModuleViews(["brain"], "server")).toEqual(["brain"]);
	expect(unhideModuleViews([], "feed")).toEqual([]);
});

test("every panel belongs to a module; the code panels to the editor", () => {
	expect(PANEL_KINDS.every((p) => typeof PANEL_MODULE[p] === "string")).toBe(true);
	expect((["editor", "explorer", "search", "git", "sessions"] as const).map((p) => PANEL_MODULE[p])).toEqual(["editor", "editor", "editor", "editor", "editor"]);
	expect(PANEL_MODULE.chat).toBe("chat");
	expect(PANEL_MODULE.terminal).toBe("terminal");
});
test("a disabled module's panels are not allowed; chat and editor always are", () => {
	const modules = mergeModules(DEFAULT_MODULES, { server: { enabled: false }, terminal: { enabled: false } });
	expect(panelEnabled("server", modules)).toBe(false);
	expect(panelEnabled("terminal", modules)).toBe(false);
	expect(panelEnabled("automations", modules)).toBe(true);
	expect(panelEnabled("chat", modules)).toBe(true);
	expect(panelEnabled("explorer", modules)).toBe(true);
});
