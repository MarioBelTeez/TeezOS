import { describe, expect, test } from "vitest";
import { matchConcept, safeFileName, safeSkillName } from "./names.ts";
import { isSkillName } from "./skills.ts";
import { writePathRefusal, type RealPath } from "./guard.ts";

const identity: RealPath = (p) => p;
const vault = "C:\\vault";

describe("matchConcept with lookalike dashes", () => {
	test("an old title with U+2010 matches the same name typed with a hyphen", () => {
		expect(matchConcept("short-form vertical video marketing", ["short‐form vertical video marketing"])).toBe("short‐form vertical video marketing");
	});
});

describe("safeFileName", () => {
	test("lookalike dashes become a plain hyphen and curly apostrophes a straight one, so typed links resolve", () => {
		expect(safeFileName("short‐form video", "x")).toBe("short-form video");
		expect(safeFileName("wire‑guided ‒ − x", "x")).toBe("wire-guided - - x");
		expect(safeFileName("Rendy – Listing — Videos", "x")).toBe("Rendy - Listing - Videos");
		expect(safeFileName("d’une vidéo", "x")).toBe("d'une vidéo");
	});
	test("keeps an ordinary title", () => {
		expect(safeFileName("How hooks work (2026)", "Untitled")).toBe("How hooks work (2026)");
	});

	test("removes characters invalid in file names and in wikilinks", () => {
		expect(safeFileName('a<b>c:d"e/f\\g|h?i*j', "x")).toBe("a b c d e f g h i j");
		expect(safeFileName("Intro [[Part]] #1 ^x", "x")).toBe("Intro Part 1 x");
	});

	test("path traversal and separators cannot survive", () => {
		for (const raw of ["../../CLAUDE", "..\\..\\x", "a/../b", "C:\\Windows\\x", "//host/share"]) {
			const name = safeFileName(raw, "x");
			expect(name, raw).not.toMatch(/[\\/:]/);
			expect(name.startsWith("."), raw).toBe(false);
		}
	});

	test("leading dots, trailing dots and spaces are dropped", () => {
		expect(safeFileName("..hidden.. ", "x")).toBe("hidden");
		expect(safeFileName(".claude", "x")).toBe("claude note");
	});

	test("reserved device names get a suffix", () => {
		for (const raw of ["CON", "nul", "Com1", "LPT9", "aux.txt", "PRN", "con .txt", "CONIN$", "conout$", "Clock$", "nul "]) {
			const name = safeFileName(raw, "x");
			expect(name.split(".")[0]?.trimEnd().toLowerCase(), raw).not.toMatch(/^(con|nul|com\d|lpt\d|aux|prn|conin\$|conout\$|clock\$)$/);
			expect(writePathRefusal(vault, `reference/sources/${name}.md`, identity), raw).toBeNull();
		}
	});

	test("instruction file names are never produced", () => {
		for (const raw of ["CLAUDE", "claude.md", "Agents", "GEMINI", "claude.local", "AGENTS.MD"]) {
			const name = safeFileName(raw, "x");
			expect(writePathRefusal(vault, `brain/concepts/${name}.md`, identity), raw).toBeNull();
			expect(name.toLowerCase(), raw).not.toMatch(/^(claude|agents|gemini)(\.md|\.local)?$/);
		}
	});

	test("8.3 short-name patterns are defused", () => {
		const name = safeFileName("CLAUDE~1", "x");
		expect(writePathRefusal(vault, `brain/concepts/${name}.md`, identity)).toBeNull();
	});

	test("caps the length and falls back when nothing is left", () => {
		expect(safeFileName("a".repeat(500), "x").length).toBeLessThanOrEqual(80);
		expect(safeFileName("///", "Untitled source")).toBe("Untitled source");
		expect(safeFileName("", "Untitled source")).toBe("Untitled source");
		expect(safeFileName("   ", "Untitled source")).toBe("Untitled source");
	});

	test("control and invisible characters are removed", () => {
		const name = safeFileName("a\u0000b\u202ec\u200bd\n", "x");
		expect(name).toBe("a b c d");
	});

	test("every produced name passes the write rules in the source and concept folders", () => {
		const nasty = ["con", "../x", "CLAUDE.md", "a:b", "x.", "~1", "AGENTS~1", " . ", "NUL.md", "$MFT", "x".repeat(300)];
		for (const raw of nasty) {
			const name = safeFileName(raw, "Untitled");
			expect(writePathRefusal(vault, `reference/sources/${name}.md`, identity), raw).toBeNull();
			expect(writePathRefusal(vault, `brain/concepts/${name}.md`, identity), raw).toBeNull();
		}
	});
});

describe("safeSkillName", () => {
	test("makes a valid skill name", () => {
		expect(safeSkillName("Hook Pattern!")).toBe("hook-pattern");
		expect(isSkillName(safeSkillName("Hook Pattern!") ?? "")).toBe(true);
	});

	test("caps at 60 characters and refuses names with nothing left", () => {
		expect(safeSkillName("a".repeat(100))?.length).toBe(60);
		expect(safeSkillName("!!!")).toBeNull();
		expect(safeSkillName("../../x")).toBe("x");
	});
});

describe("matchConcept", () => {
	const existing = ["Prompt Caching", "Hooks", "claude code"];

	test("matches an existing title case-insensitively and returns its spelling", () => {
		expect(matchConcept("prompt caching", existing)).toBe("Prompt Caching");
		expect(matchConcept("HOOKS", existing)).toBe("Hooks");
		expect(matchConcept("Claude Code", existing)).toBe("claude code");
	});

	test("matches through the same sanitising as the file name", () => {
		expect(matchConcept("Prompt: Caching?", ["Prompt Caching"])).toBe("Prompt Caching");
	});

	test("returns null for a new concept", () => {
		expect(matchConcept("Tool use", existing)).toBeNull();
	});
});
