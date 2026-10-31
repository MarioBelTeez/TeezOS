import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The three BelTeez faces must ship inside the app.
 *
 * Dropping an import here fails silently: the browser falls back to a system
 * face, the app still runs, every test still passes, and the only symptom is
 * that it stops looking like BelTeez. It shipped that way once already.
 *
 * Fetching them from Google Fonts instead would fail twice over — offline,
 * and against the renderer's own CSP, which allows font-src 'self' only.
 */

const read = (path: string): string =>
	readFileSync(join(import.meta.dirname, path), "utf-8");

describe("bundled fonts", () => {
	const css = read("index.css");

	test("Bebas Neue is imported for the display face", () => {
		expect(css).toContain("@fontsource/bebas-neue/latin-400.css");
	});

	test("Barlow Condensed ships the weights the interface uses", () => {
		for (const weight of [400, 600, 700]) {
			expect(css).toContain(`@fontsource/barlow-condensed/latin-${weight}.css`);
		}
	});

	test("DM Mono ships the weights code and paths are set in", () => {
		for (const weight of [400, 500]) {
			expect(css).toContain(`@fontsource/dm-mono/latin-${weight}.css`);
		}
	});

	test("the font tokens still name those families first", () => {
		expect(css).toMatch(/--font-display:\s*"Bebas Neue"/);
		expect(css).toMatch(/--font-condensed:\s*"Barlow Condensed"/);
		expect(css).toMatch(/--font-mono:\s*"DM Mono"/);
	});

	test("nothing is pulled from a font CDN", () => {
		expect(css).not.toContain("fonts.googleapis.com");
		expect(css).not.toContain("fonts.gstatic.com");
	});

	test("the packages are declared, so a fresh clone gets the files", () => {
		const pkg = JSON.parse(read("../../package.json")) as {
			devDependencies?: Record<string, string>;
		};
		const deps = pkg.devDependencies ?? {};
		expect(deps).toHaveProperty("@fontsource/bebas-neue");
		expect(deps).toHaveProperty("@fontsource/barlow-condensed");
		expect(deps).toHaveProperty("@fontsource/dm-mono");
	});
});
