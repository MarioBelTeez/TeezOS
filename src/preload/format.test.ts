import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import config from "../../electron.vite.config.ts";

/**
 * A sandboxed preload must be CommonJS.
 *
 * This cost a blank window: with `"type": "module"` in package.json,
 * electron-vite emitted `out/preload/index.mjs`, and Electron refused it —
 * "Unable to load preload script … SyntaxError: Cannot use import statement
 * outside a module". The bridge never loaded, so `window.teez` was undefined,
 * the first render threw, and the app showed nothing but its background colour.
 *
 * The window's own security settings are asserted here too: turning off
 * `sandbox` would also "fix" the symptom, and would quietly hand the renderer
 * the Node runtime the design deliberately keeps away from it.
 */

const outputOptions = (): Record<string, unknown> => {
	const preload = (config as { preload?: Record<string, unknown> }).preload ?? {};
	const build = (preload["build"] ?? {}) as Record<string, unknown>;
	const rollup = (build["rollupOptions"] ?? {}) as Record<string, unknown>;
	return (rollup["output"] ?? {}) as Record<string, unknown>;
};

describe("preload build output", () => {
	test("is built as CommonJS, because a sandboxed preload cannot be ESM", () => {
		expect(outputOptions()["format"]).toBe("cjs");
	});

	test("is named .cjs, so Node does not read it as a module despite type:module", () => {
		expect(outputOptions()["entryFileNames"]).toBe("index.cjs");
	});

	test("main loads that exact file", () => {
		const source = readFileSync(join(import.meta.dirname, "../main/index.ts"), "utf-8");
		expect(source).toContain("preload/index.cjs");
		expect(source).not.toContain("preload/index.mjs");
	});

	test("the sandbox stays on — the fix is the format, not the boundary", () => {
		const source = readFileSync(join(import.meta.dirname, "../main/index.ts"), "utf-8");
		expect(source).toContain("sandbox: true");
		expect(source).toContain("contextIsolation: true");
		expect(source).toContain("nodeIntegration: false");
	});
});
