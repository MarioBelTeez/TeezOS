import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFiledSource, scanSourceNotes } from "./history.ts";

let vault: string;
const dir = (): string => join(vault, "reference", "sources");
const note = (name: string, text: string, mtime?: number): void => {
	writeFileSync(join(dir(), name), text);
	if (mtime !== undefined) utimesSync(join(dir(), name), mtime / 1000, mtime / 1000);
};
const untrusted = (extra = ""): string => `---\ndate: 2026-10-05\nurl: "https://example.com/a"\nkind: article\nprovenance: feed-untrusted\n${extra}---\n# Body\n`;

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "feed-history-"));
	mkdirSync(dir(), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("scanSourceNotes", () => {
	test("returns the notes stamped feed-untrusted with title, date, url and kind from the frontmatter", async () => {
		note("Talk.md", untrusted());
		const found = await scanSourceNotes(vault);
		expect(found).toEqual([{ path: "reference/sources/Talk.md", title: "Talk", date: new Date(2026, 9, 5).getTime(), url: "https://example.com/a", kind: "article" }]);
	});

	test("ignores notes without the stamp, other files and folders", async () => {
		note("Mine.md", "---\ndate: 2026-01-01\n---\nmy own note\n");
		note("NoFrontmatter.md", "# plain\n");
		note("Image.png", "x");
		mkdirSync(join(dir(), "Folder.md"));
		note("Trusted.md", "---\nprovenance: me\n---\n");
		expect(await scanSourceNotes(vault)).toEqual([]);
	});

	test("falls back to the file's modified time and to empty url and kind", async () => {
		note("Bare.md", "---\nprovenance: feed-untrusted\n---\ntext\n", Date.UTC(2026, 0, 2));
		const [found] = await scanSourceNotes(vault);
		expect(found).toMatchObject({ title: "Bare", url: "", kind: "" });
		expect(found?.date).toBe(Date.UTC(2026, 0, 2));
	});

	test("reads only the head of a note: a stamp after a long body does not count", async () => {
		note("Late.md", `---\ndate: 2026-10-05\n---\n${"x".repeat(20_000)}\nprovenance: feed-untrusted\n`);
		expect(await scanSourceNotes(vault)).toEqual([]);
	});

	test("a hostile frontmatter value cannot become a long or multi-line field", async () => {
		note("Evil.md", untrusted(`url: ${JSON.stringify("https://x/" + "a".repeat(3000))}\n`));
		const [found] = await scanSourceNotes(vault);
		expect(found?.url.length).toBeLessThanOrEqual(500);
	});

	test("caps the number of notes, keeping the newest", async () => {
		for (let i = 0; i < 12; i += 1) note(`N${i}.md`, untrusted(), 1_000_000 + i);
		const found = await scanSourceNotes(vault, 5);
		expect(found).toHaveLength(5);
	});

	test("a vault without reference/sources has nothing", async () => {
		rmSync(join(vault, "reference"), { recursive: true });
		expect(await scanSourceNotes(vault)).toEqual([]);
	});
});

describe("findFiledSource", () => {
	test("finds the note filed from a link, by its url frontmatter", async () => {
		note("Talk.md", untrusted());
		note("Other.md", untrusted().replace("https://example.com/a", "https://example.com/b"));
		expect(await findFiledSource(vault, "https://example.com/a")).toBe("reference/sources/Talk.md");
		expect(await findFiledSource(vault, "https://example.com/zzz")).toBeNull();
	});

	test("nothing when the folder is missing", async () => {
		rmSync(join(vault, "reference"), { recursive: true });
		expect(await findFiledSource(vault, "https://example.com/a")).toBeNull();
	});
});
