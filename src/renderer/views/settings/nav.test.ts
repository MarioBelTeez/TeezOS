import { expect, test } from "vitest";
import { SETTINGS_LABEL, SETTINGS_PAGES, isSettingsPage } from "./nav.ts";

test("the sections in the spec's order", () => {
	expect(SETTINGS_PAGES.map((p) => SETTINGS_LABEL[p])).toEqual([
		"General", "Chat", "Editor", "Terminal", "Brain", "Feed", "Browser", "Agents", "Server", "Automations", "Discord", "Presets", "Projects", "Updates", "About",
	]);
	expect(isSettingsPage("presets")).toBe(true);
	expect(isSettingsPage("nope")).toBe(false);
});
