import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractLinks, parseNote, scanVault, readNote, slugPath } from "./vault.ts";

describe("parseNote", () => {
	test("splits frontmatter from the body and reads the usual fields", () => {
		const note = parseNote(
			"work/active/Proxmox Homelab Server.md",
			['---', 'date: 2026-09-30', 'description: "Headless Proxmox"', "tags:", "  - work-note", "aliases: [PVE, Homelab]", "status: active", "---", "# Body", "See [[North Star]]."].join("\n"),
			1000,
		);
		expect(note.title).toBe("Proxmox Homelab Server");
		expect(note.description).toBe("Headless Proxmox");
		expect(note.tags).toEqual(["work-note"]);
		expect(note.aliases).toEqual(["PVE", "Homelab"]);
		expect(note.status).toBe("active");
		expect(note.body.startsWith("# Body")).toBe(true);
		expect(note.links).toEqual(["North Star"]);
	});

	test("broken frontmatter does not lose the note", () => {
		const note = parseNote("a.md", "---\n: : bad yaml [\n---\ntext [[B]]", 0);
		expect(note.title).toBe("a");
		expect(note.links).toEqual(["B"]);
	});
});

describe("extractLinks", () => {
	test("targets without aliases, headings or block refs, embeds included, code ignored", () => {
		const body = [
			"[[One]] and [[Two|shown]] and [[Three#Heading]] and ![[Four.png]] and [[Five#^block]]",
			"`[[not a link]]`",
			"```",
			"[[also not]]",
			"```",
			"[[One]] again",
		].join("\n");
		expect(extractLinks(body)).toEqual(["One", "Two", "Three", "Four.png", "Five"]);
	});
});

describe("slugPath", () => {
	test("matches QMD's file naming", () => {
		expect(slugPath("work/active/Proxmox Homelab Server.md")).toBe("work/active/Proxmox-Homelab-Server.md");
		expect(slugPath("org/People & Context.md")).toBe("org/People-Context.md");
	});
});

describe("scanVault", () => {
	let root: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "teez-vault-"));
		mkdirSync(join(root, "brain"));
		mkdirSync(join(root, "work", "active"), { recursive: true });
		mkdirSync(join(root, ".obsidian"));
		mkdirSync(join(root, "templates"));
		writeFileSync(join(root, "Home.md"), "Start at [[North Star]] and [[Proxmox Homelab Server|the server]].");
		writeFileSync(join(root, "brain", "North Star.md"), "---\naliases: [Goals]\n---\nGoals. See [[Home]].");
		writeFileSync(join(root, "work", "active", "Proxmox Homelab Server.md"), "Back to [[Goals]] and [[work/active/Missing]].");
		writeFileSync(join(root, ".obsidian", "app.md"), "ignored");
		writeFileSync(join(root, "templates", "T.md"), "ignored");
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	test("indexes notes, resolves links by name, path and alias, and counts backlinks", async () => {
		const index = await scanVault(root);
		expect(index.notes.map((n) => n.path).sort()).toEqual(["Home.md", "brain/North Star.md", "work/active/Proxmox Homelab Server.md"]);
		const edges = index.edges.map((e) => `${e.from} -> ${e.to}`).sort();
		expect(edges).toEqual([
			"Home.md -> brain/North Star.md",
			"Home.md -> work/active/Proxmox Homelab Server.md",
			"brain/North Star.md -> Home.md",
			"work/active/Proxmox Homelab Server.md -> brain/North Star.md",
		]);
		expect(index.unresolved).toEqual([{ from: "work/active/Proxmox Homelab Server.md", target: "work/active/Missing" }]);
		const star = index.notes.find((n) => n.path === "brain/North Star.md");
		expect(star?.backlinks).toBe(2);
	});

	test("readNote returns the body and who links here", async () => {
		const note = await readNote(root, "brain/North Star.md");
		expect(note?.body).toBe("Goals. See [[Home]].");
		expect(note?.backlinks.map((b) => b.path).sort()).toEqual(["Home.md", "work/active/Proxmox Homelab Server.md"]);
		expect(note?.backlinks.find((b) => b.path === "Home.md")?.context).toContain("North Star");
		expect(await readNote(root, "../etc.md")).toBeNull();
	});
});

describe("links to templates and files", () => {
	let root: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "teez-vault-files-"));
		mkdirSync(join(root, "templates"));
		mkdirSync(join(root, "bases"));
		writeFileSync(join(root, "Home.md"), "Use [[Work Note]]. ![[Work Dashboard.base#Active Work]] ![[Ghost.png]] [[Nowhere]]");
		writeFileSync(join(root, "templates", "Work Note.md"), "# {{title}}");
		writeFileSync(join(root, "bases", "Work Dashboard.base"), "views: []");
		mkdirSync(join(root, "bases", "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(root, "bases", "node_modules", "pkg", "Nowhere.md"), "a package readme, not a note");
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	test("templates and files resolve, but stay out of the note list and the graph", async () => {
		const index = await scanVault(root);
		expect(index.notes.map((n) => n.path)).toEqual(["Home.md"]);
		expect(index.edges).toEqual([]);
		expect(index.unresolved.map((u) => u.target)).toEqual(["Ghost.png", "Nowhere"]);
	});

	test("the reader learns what each link is: a note, a file for Obsidian, or nothing", async () => {
		const note = await readNote(root, "Home.md");
		expect(note?.outgoing).toEqual([
			{ target: "Work Note", path: "templates/Work Note.md", kind: "note" },
			{ target: "Work Dashboard.base", path: "bases/Work Dashboard.base", kind: "file" },
			{ target: "Ghost.png", path: null, kind: "missing" },
			{ target: "Nowhere", path: null, kind: "missing" },
		]);
	});
});
