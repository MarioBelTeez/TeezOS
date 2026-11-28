import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DEFAULT_THEME_ID, THEME_IDS, THEMES, isThemeId, themeById, themeVars } from "./themes.ts";

describe("themes", () => {
	test("BelTeez Crimson is the default and every listed id has a theme", () => {
		expect(DEFAULT_THEME_ID).toBe("belteez-crimson");
		expect(THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
	});

	test("only known ids are themes", () => {
		expect(isThemeId("nord-frost")).toBe(true);
		expect(isThemeId("daylight-clean")).toBe(false);
		expect(isThemeId(undefined)).toBe(false);
	});

	test("an unknown id falls back to the default rather than throwing", () => {
		expect(themeById("gone-theme").id).toBe("belteez-crimson");
	});

	test("the crimson theme reproduces index.css exactly, so the default look does not shift", () => {
		const css = readFileSync(new URL("../renderer/index.css", import.meta.url), "utf8");
		const vars = themeVars(themeById("belteez-crimson"));
		for (const name of ["--color-red", "--color-red-hot", "--color-bg", "--color-surface", "--color-surface-2", "--color-border", "--color-muted", "--color-text"]) {
			const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));
			expect(match?.[1]?.trim().toLowerCase(), name).toBe(vars[name]);
		}
	});

	test("translucent tokens are derived from the theme's own colours", () => {
		const vars = themeVars(themeById("nord-frost"));
		expect(vars["--color-red-rgb"]).toBe("136 192 208");
		expect(vars["--color-glow"]).toBe("rgb(136 192 208 / 0.42)");
		expect(vars["--color-glass"]).toBe("rgb(36 42 54 / 0.72)");
	});

	test("pastel accents get dark text on top, so solid buttons stay readable", () => {
		for (const id of ["catppuccin-mocha", "nord-frost", "clean-dark"] as const) {
			expect(themeById(id).tokens.onRed).not.toBe("#ffffff");
		}
	});
});
