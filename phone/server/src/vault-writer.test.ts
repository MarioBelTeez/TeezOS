import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureNote, writeNewNote } from "./vault-writer.ts";

let vault: string;
beforeEach(async () => {
	vault = await mkdtemp(path.join(tmpdir(), "phone-vault-"));
});
afterEach(async () => {
	await rm(vault, { recursive: true, force: true });
});

const NOW = new Date(2026, 9, 17, 14, 5).getTime();

describe("captureNote", () => {
	it("builds the file name, frontmatter and related links", () => {
		const note = captureNote("Idea about the feed pipeline and more words after", NOW, ["Patterns"]);
		expect(note.rel).toMatch(/^thinking\/phone-2026-10-17-\d{4}-Idea about the feed pipeline and\.md$/);
		expect(note.content).toContain("provenance: phone");
		expect(note.content).toMatch(/tags: \[thinking, phone-capture\]/);
		expect(note.content).toContain("## Related\n\n[[Patterns]]");
	});
	it("cuts text to 4000 characters and the description to 150", () => {
		const note = captureNote("x".repeat(5000), NOW, []);
		const body = note.content.split("---\n").at(-1) ?? "";
		expect(body.length).toBeLessThan(4100);
		const description = /description: "(.*)"/.exec(note.content)?.[1] ?? "";
		expect(description.length).toBe(150);
	});
});

describe("writeNewNote", () => {
	it("writes a capture under thinking/ with the phone frontmatter", async () => {
		const note = captureNote("hello world", NOW, []);
		const result = await writeNewNote(vault, note.rel, note.content);
		expect(result).toEqual({ ok: true, rel: note.rel });
		const text = await readFile(path.join(vault, note.rel), "utf8");
		expect(text).toContain("provenance: phone");
		expect(text).toMatch(/tags: \[thinking, phone-capture\]/);
	});
	it("numbers a second capture with the same name", async () => {
		const first = await writeNewNote(vault, "thinking/a.md", "one");
		const second = await writeNewNote(vault, "thinking/a.md", "two");
		const third = await writeNewNote(vault, "thinking/a.md", "three");
		expect(first).toEqual({ ok: true, rel: "thinking/a.md" });
		expect(second).toEqual({ ok: true, rel: "thinking/a-2.md" });
		expect(third).toEqual({ ok: true, rel: "thinking/a-3.md" });
	});
	it("refuses paths outside the allowed folders", async () => {
		for (const rel of ["CLAUDE.md", "../x.md", "brain/Gotchas.md", ".claude/x.md", "thinking/x.txt", "thinking/CLAUDE.md"]) {
			const result = await writeNewNote(vault, rel, "x");
			expect(result.ok, rel).toBe(false);
		}
		expect(await readdir(vault)).toEqual([]);
	});
	it("refuses an absolute path, even one inside the vault, and leaves the disk untouched", async () => {
		for (const rel of [path.join(vault, "thinking", "x.md"), "/thinking/x.md", "C:\\x\\thinking\\x.md", "thinking\\x.md"]) {
			expect((await writeNewNote(vault, rel, "x")).ok, rel).toBe(false);
		}
		expect(await readdir(vault)).toEqual([]);
	});
	it("allows the other phone folders", async () => {
		for (const rel of ["reference/sources/s.md", "brain/concepts/c.md", "thinking/skill-drafts/d.md"]) {
			expect((await writeNewNote(vault, rel, "x")).ok, rel).toBe(true);
		}
	});
	it("never overwrites an existing file", async () => {
		await mkdir(path.join(vault, "thinking"));
		await writeFile(path.join(vault, "thinking/a.md"), "original");
		await writeNewNote(vault, "thinking/a.md", "new");
		expect(await readFile(path.join(vault, "thinking/a.md"), "utf8")).toBe("original");
	});
	it("fails when all numbered names are taken", async () => {
		await mkdir(path.join(vault, "thinking"));
		await writeFile(path.join(vault, "thinking/a.md"), "x");
		for (let n = 2; n <= 20; n++) await writeFile(path.join(vault, `thinking/a-${n}.md`), "x");
		expect((await writeNewNote(vault, "thinking/a.md", "new")).ok).toBe(false);
	});
});
