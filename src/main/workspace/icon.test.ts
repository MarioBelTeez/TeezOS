import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findIconLinks, findWorkspaceIcon, MAX_ICON_BYTES } from "./icon.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("findIconLinks", () => {
	test("icon links in any attribute order, apple-touch-icon last, remote ones skipped", () => {
		const html = `
			<link rel="apple-touch-icon" href="/apple.png">
			<link href="/favicon.png?v=4" rel="icon" type="image/png" />
			<LINK REL="shortcut icon" HREF='img/fav.ico'>
			<link rel="icon" href="https://cdn.example.com/x.png">
			<link rel="stylesheet" href="/styles.css">`;
		expect(findIconLinks(html)).toEqual(["/favicon.png", "img/fav.ico", "/apple.png"]);
	});
});

describe("findWorkspaceIcon", () => {
	let root: string;
	let custom: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "teez-icon-"));
		custom = mkdtempSync(join(tmpdir(), "teez-icon-custom-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(custom, { recursive: true, force: true });
	});

	test("a folder without a logo has none (the tile shows initials)", async () => {
		expect(await findWorkspaceIcon(root, null)).toBeNull();
	});

	test("a well-known file: build/icon.png, as in an Electron app", async () => {
		mkdirSync(join(root, "build"));
		writeFileSync(join(root, "build", "icon.png"), PNG);
		const icon = await findWorkspaceIcon(root, null);
		expect(icon?.source).toBe("build/icon.png");
		expect(icon?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
	});

	test("an SVG favicon wins over a PNG one", async () => {
		mkdirSync(join(root, "public"));
		writeFileSync(join(root, "public", "favicon.png"), PNG);
		writeFileSync(join(root, "public", "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
		expect((await findWorkspaceIcon(root, null))?.source).toBe("public/favicon.svg");
	});

	test("the favicon a page links, resolved as the site serves it (/assets → src/assets)", async () => {
		mkdirSync(join(root, "src", "assets", "marks"), { recursive: true });
		writeFileSync(join(root, "src", "layout.html"), `<link rel="icon" type="image/png" href="/assets/marks/pittogramma-malva.png">`);
		writeFileSync(join(root, "src", "assets", "marks", "pittogramma-malva.png"), PNG);
		expect((await findWorkspaceIcon(root, null))?.source).toBe("src/assets/marks/pittogramma-malva.png");
	});

	test("a picked image overrides whatever the folder has", async () => {
		mkdirSync(join(root, "build"));
		writeFileSync(join(root, "build", "icon.png"), PNG);
		writeFileSync(join(custom, "mine.png"), PNG);
		expect((await findWorkspaceIcon(root, join(custom, "mine.png")))?.source).toBe("custom");
	});

	test("a link that leaves the folder, or a file too large, is not used", async () => {
		writeFileSync(join(root, "index.html"), `<link rel="icon" href="../../outside.png"><link rel="icon" href="/big.png">`);
		writeFileSync(join(root, "big.png"), Buffer.alloc(MAX_ICON_BYTES + 1));
		expect(await findWorkspaceIcon(root, null)).toBeNull();
	});
});
