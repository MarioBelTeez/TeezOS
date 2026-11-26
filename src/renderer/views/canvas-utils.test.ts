import { describe, expect, it } from "vitest";
import { buildSandboxedSrcDoc, canvasKindForPath, extractArtifactsFromMarkdown } from "./canvas-utils.ts";

describe("canvas-utils", () => {
	it("extracts svg and html code blocks from assistant markdown", () => {
		const md = [
			"Here is a wireframe:",
			"```svg",
			"<svg width='100' height='100'><rect width='100' height='100' fill='red'/></svg>",
			"```",
			"And a mockup:",
			"```html",
			"<div>Hello</div>",
			"```",
			"```ts",
			"const x = 1;",
			"```",
		].join("\n");

		const artifacts = extractArtifactsFromMarkdown(md, "m1");
		expect(artifacts).toHaveLength(2);
		expect(artifacts[0]?.kind).toBe("svg");
		expect(artifacts[0]?.title).toBe("Agent SVG #1");
		expect(artifacts[1]?.kind).toBe("html");
		expect(artifacts[1]?.title).toBe("Agent HTML #2");
	});

	it("maps workspace file extensions to canvas viewer kinds", () => {
		expect(canvasKindForPath("diagram.svg")).toBe("svg");
		expect(canvasKindForPath("mock/index.HTML")).toBe("html");
		expect(canvasKindForPath("README.md")).toBe("markdown");
		expect(canvasKindForPath("main.ts")).toBeNull();
	});

	it("wraps SVG content cleanly for sandboxed iframe rendering", () => {
		const doc = buildSandboxedSrcDoc("svg", "<svg></svg>");
		expect(doc).toContain("<!doctype html>");
		expect(doc).toContain("<svg></svg>");
	});
});
