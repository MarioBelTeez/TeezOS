import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardDraft, draftRefusal, installSkill, isSkillName, previewDraft } from "./skills.ts";

/** Draft folders holding a SKILL.md, sorted. */
async function listDrafts(root: string): Promise<string[]> {
	const base = join(root, "thinking", "skill-drafts");
	if (!existsSync(base)) return [];
	return readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(base, e.name, "SKILL.md"))).map((e) => e.name).sort();
}

let vault: string;
beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "feed-"));
	mkdirSync(join(vault, "thinking", "skill-drafts", "hook-pattern"), { recursive: true });
	writeFileSync(join(vault, "thinking", "skill-drafts", "hook-pattern", "SKILL.md"), "---\nname: hook-pattern\n---\n");
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("skills", () => {
	test("names are strict", () => {
		expect(isSkillName("hook-pattern")).toBe(true);
		for (const bad of ["../x", "Hook", "a b", "", "x".repeat(61), "..\\evil"]) expect(isSkillName(bad)).toBe(false);
	});
	test("lists and installs a draft", async () => {
		expect(await listDrafts(vault)).toEqual(["hook-pattern"]);
		expect(await installSkill(vault, "hook-pattern")).toEqual({ ok: true });
		expect(existsSync(join(vault, ".claude", "skills", "hook-pattern", "SKILL.md"))).toBe(true);
	});
	test("refuses traversal, missing drafts and overwriting", async () => {
		expect((await installSkill(vault, "../../etc")).ok).toBe(false);
		expect((await installSkill(vault, "nope")).ok).toBe(false);
		await installSkill(vault, "hook-pattern");
		expect((await installSkill(vault, "hook-pattern")).ok).toBe(false);
	});
	test("discard removes only the draft", async () => {
		await discardDraft(vault, "hook-pattern");
		expect(existsSync(join(vault, "thinking", "skill-drafts", "hook-pattern"))).toBe(false);
		expect(existsSync(join(vault, "thinking"))).toBe(true);
	});
	test("copies nested files, refuses a draft without SKILL.md, lists none without the folder", async () => {
		mkdirSync(join(vault, "thinking", "skill-drafts", "hook-pattern", "refs"), { recursive: true });
		writeFileSync(join(vault, "thinking", "skill-drafts", "hook-pattern", "refs", "a.md"), "x");
		mkdirSync(join(vault, "thinking", "skill-drafts", "empty"), { recursive: true });
		expect(await listDrafts(vault)).toEqual(["hook-pattern"]);
		expect((await installSkill(vault, "empty")).ok).toBe(false);
		expect(existsSync(join(vault, ".claude", "skills", "empty"))).toBe(false);
		expect(await installSkill(vault, "hook-pattern")).toEqual({ ok: true });
		expect(existsSync(join(vault, ".claude", "skills", "hook-pattern", "refs", "a.md"))).toBe(true);
		rmSync(join(vault, "thinking"), { recursive: true, force: true });
		expect(await listDrafts(vault)).toEqual([]);
	});
	test("links never redirect an install or a discard outside the drafts folder", async () => {
		const outside = mkdtempSync(join(tmpdir(), "feed-outside-"));
		try {
			mkdirSync(join(outside, "victim"), { recursive: true });
			writeFileSync(join(outside, "victim", "SKILL.md"), "keep me");
			// A draft that is a link to a folder elsewhere.
			symlinkSync(join(outside, "victim"), join(vault, "thinking", "skill-drafts", "victim"), "junction");
			expect(await listDrafts(vault)).toEqual(["hook-pattern"]);
			expect((await installSkill(vault, "victim")).ok).toBe(false);
			expect((await discardDraft(vault, "victim")).ok).toBe(false);
			expect(existsSync(join(outside, "victim", "SKILL.md"))).toBe(true);
			// The whole drafts folder swapped for a link elsewhere.
			rmSync(join(vault, "thinking"), { recursive: true, force: true });
			mkdirSync(join(vault, "thinking"));
			symlinkSync(outside, join(vault, "thinking", "skill-drafts"), "junction");
			expect((await discardDraft(vault, "victim")).ok).toBe(false);
			expect((await installSkill(vault, "victim")).ok).toBe(false);
			expect(existsSync(join(outside, "victim", "SKILL.md"))).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
	test("a linked .claude is refused before anything is created at its target", async () => {
		const outside = mkdtempSync(join(tmpdir(), "feed-claude-"));
		try {
			symlinkSync(outside, join(vault, ".claude"), "junction");
			expect((await installSkill(vault, "hook-pattern")).ok).toBe(false);
			expect(existsSync(join(outside, "skills"))).toBe(false);
		} finally {
			rmSync(join(vault, ".claude"), { recursive: false, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
	test("a linked .claude/skills is refused too", async () => {
		const outside = mkdtempSync(join(tmpdir(), "feed-skills-"));
		try {
			mkdirSync(join(vault, ".claude"));
			symlinkSync(outside, join(vault, ".claude", "skills"), "junction");
			expect((await installSkill(vault, "hook-pattern")).ok).toBe(false);
			expect(existsSync(join(outside, "hook-pattern"))).toBe(false);
		} finally {
			rmSync(join(vault, ".claude", "skills"), { recursive: false, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
	test("draftRefusal: only markdown files, and no allowed-tools or hooks in SKILL.md's frontmatter", () => {
		const ok = "---\nname: x\ndescription: y\n---\n# Body mentions hooks: and allowed-tools: freely\n";
		expect(draftRefusal(["SKILL.md", "refs/a.md", "refs/B.MD"], ok)).toBeNull();
		for (const file of ["run.ps1", "refs/x.js", "a.md.exe", "Makefile", "refs/.env"]) {
			expect(draftRefusal(["SKILL.md", file], ok), file).toMatch(/markdown/);
		}
		for (const frontmatter of [
			"---\nname: x\nallowed-tools: Bash\n---\n",
			"---\nname: x\nAllowed-Tools:\n  - Bash\n---\n",
			"---\nname: x\nhooks:\n  PreToolUse: []\n---\n",
			"---\r\nname: x\r\n\"hooks\": {}\r\n---\r\n",
			"---\nname: x\nmetadata:\n  allowed-tools: Bash\n---\n",
			`${String.fromCharCode(0xfeff)}---\nallowed_tools: Bash\n---\n`,
			// YAML explicit keys, any indent, quoted or not.
			"---\nname: x\n? allowed-tools\n: Bash\n---\n",
			"---\nname: x\n  ?   hooks\n  : {}\n---\n",
			"---\nname: x\n? \"allowed-tools\"\n: Bash\n---\n",
			"---\nname: x\n?\t'hooks'\n: {}\n---\n",
			// Quoted keys, either quote.
			"---\nname: x\n\"allowed-tools\": Bash\n---\n",
			"---\nname: x\n'hooks': {}\n---\n",
			"---\nname: x\n  'allowed-tools' : Bash\n---\n",
			// Flow mappings.
			"---\nname: x\nmetadata: { allowed-tools: Bash }\n---\n",
			"---\nname: x\nmetadata: {a: 1, \"hooks\": {}}\n---\n",
			// The gaps a denylist leaves: multi-line explicit keys, flow keys, comments, anchors and tags, escaped quotes.
			"---\nname: x\n?\n  hooks\n: {}\n---\n",
			"---\nname: x\n? [hooks]\n: {}\n---\n",
			"---\nname: x\nhooks: # comment\n  PreToolUse: []\n---\n",
			"---\nname: x\nhooks : {}\n---\n",
			"---\nname: x\n&a hooks: {}\n---\n",
			"---\nname: x\n!!str hooks: {}\n---\n",
			"---\nname: x\n\"ho\\x6fks\": {}\n---\n",
			"---\nname: x\n\"allowed\\u002dtools\": Bash\n---\n",
			"---\nname: x\nmodel: opus\n---\n",
			"---\nname: x\n- hooks\n---\n",
			"---\nname: x\n{ hooks: {} }\n---\n",
			"---\nname: x\n[a]: b\n---\n",
			// Indented lines belong only to a block scalar (| or >) of name or description.
			"---\nname: x\ndescription: plain\n  hooks: {}\n---\n",
			"---\nname: x\n  hooks: {}\n---\n",
			// Values that are not plain text.
			"---\nname: &a x\n---\n",
			"---\nname: x\ndescription: { hooks: {} }\n---\n",
			// Frontmatter after leading blank lines still counts.
			"\n\n---\nhooks: {}\n---\n",
			// Never closed: everything after the opener is frontmatter.
			"---\nname: x\nhooks: {}\n",
		]) {
			expect(draftRefusal(["SKILL.md"], frontmatter), frontmatter).toBe("SKILL.md frontmatter may only have name and description");
		}
		// Allowed: name and description (plain, quoted, or block scalars), comments, blank lines, and the feed's own provenance stamp.
		for (const allowed of [
			"---\nname: x\ndescription: explains hooks and allowed-tools\n---\n",
			"---\nname: hook-pattern\ndescription: >\n  A long description\n  over two lines: with colons.\n\n  hooks: still text\n---\nBody",
			"---\r\nname: 'x'\r\ndescription: |-\r\n  line one\r\n  line two\r\n---\r\n",
			"---\n# a comment\nname: \"x\"   # trailing comment\n\ndescription: y\nprovenance: feed-untrusted\n---\n",
			"No frontmatter at all; hooks: here is just text.",
		]) {
			expect(draftRefusal(["SKILL.md"], allowed), allowed).toBeNull();
		}
	});

	test("installing refuses a draft with other files or risky frontmatter, and creates nothing", async () => {
		const draft = join(vault, "thinking", "skill-drafts", "hook-pattern");
		writeFileSync(join(draft, "run.ps1"), "Remove-Item C:\\");
		expect(await installSkill(vault, "hook-pattern")).toMatchObject({ ok: false, reason: expect.stringMatching(/run\.ps1/) });
		rmSync(join(draft, "run.ps1"));
		writeFileSync(join(draft, "SKILL.md"), "---\nname: hook-pattern\nallowed-tools: Bash(*)\n---\n");
		expect(await installSkill(vault, "hook-pattern")).toMatchObject({ ok: false, reason: "SKILL.md frontmatter may only have name and description" });
		expect(existsSync(join(vault, ".claude", "skills", "hook-pattern"))).toBe(false);
	});

	test("the preview shows SKILL.md and every file; installing needs the draft unchanged since", async () => {
		const draft = join(vault, "thinking", "skill-drafts", "hook-pattern");
		mkdirSync(join(draft, "refs"));
		writeFileSync(join(draft, "refs", "a.md"), "ref");
		const preview = await previewDraft(vault, "hook-pattern");
		if (!preview.ok) throw new Error(preview.reason);
		expect(preview.skillMd).toBe("---\nname: hook-pattern\n---\n");
		expect([...preview.files].sort()).toEqual(["SKILL.md", "refs/a.md"]);
		expect(preview.digest).toMatch(/^[0-9a-f]{64}$/);
		// Changed after the preview: the shown version is not what would be installed.
		writeFileSync(join(draft, "refs", "a.md"), "changed");
		expect(await installSkill(vault, "hook-pattern", preview.digest)).toMatchObject({ ok: false, reason: expect.stringMatching(/changed/) });
		const again = await previewDraft(vault, "hook-pattern");
		if (!again.ok) throw new Error(again.reason);
		expect(await installSkill(vault, "hook-pattern", again.digest)).toEqual({ ok: true });
		// A draft that would be refused is refused at preview time already.
		writeFileSync(join(draft, "x.bat"), "x");
		expect(await previewDraft(vault, "hook-pattern")).toMatchObject({ ok: false, reason: expect.stringMatching(/x\.bat/) });
	});

	test("discard refuses bad names and missing drafts, leaving everything else alone", async () => {
		expect((await discardDraft(vault, "..")).ok).toBe(false);
		expect((await discardDraft(vault, "")).ok).toBe(false);
		expect((await discardDraft(vault, "nope")).ok).toBe(false);
		expect(existsSync(join(vault, "thinking", "skill-drafts", "hook-pattern"))).toBe(true);
	});
});
