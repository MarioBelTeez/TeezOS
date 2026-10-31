import { describe, expect, test, vi } from "vitest";
import { writePathRefusal, type RealPath } from "./guard.ts";

const vault = "C:\\vault";
/** The identity resolver: nothing on disk, every path is what it says. */
const identity: RealPath = (p) => p;
const guard = (file: string): string | null => writePathRefusal(vault, file, identity);

describe("feed write rules: every segment of a write is checked", () => {
	test("instruction files are refused at any depth, whatever the case or trailing dots and spaces", () => {
		for (const denied of [
			"reference/CLAUDE.md",
			"brain/concepts/CLAUDE.md",
			"reference/AGENTS.md",
			"reference/GEMINI.md",
			"reference/sources/claude.local.md",
			"reference/.mcp.json",
			"reference/CLAUDE.md.",
			"reference/CLAUDE.md. . ",
			"thinking/skill-drafts/x/Agents.MD",
		]) {
			expect(guard(denied), denied).not.toBeNull();
		}
	});

	test("dot folders and dot files are refused at any depth", () => {
		for (const denied of [
			"brain/concepts/.claude/skills/a/SKILL.md",
			"reference/.claude/skills/x/SKILL.md",
			"reference/.git/config",
			"reference/.git./hooks.md",
			"reference/sources/.hidden.md",
			"thinking/skill-drafts/x/.obsidian/app.md",
		]) {
			expect(guard(denied), denied).not.toBeNull();
		}
		expect(guard("reference/.claude/skills/x/SKILL.md")).toMatch(/\.claude/);
	});

	test("8.3 short names are refused at any depth", () => {
		for (const denied of ["reference/CLAUDE~1/skills/x/SKILL.md", "reference/sources/CLAUDE~1.MD", "brain/concepts/GIT~1/x.md", "reference/LONGNA~12.md"]) {
			expect(guard(denied), denied).not.toBeNull();
		}
	});

	test("Windows device names are refused at any depth, with any extension", () => {
		for (const denied of ["reference/CON.md", "reference/sources/nul.txt.md", "reference/aux /x.md", "brain/concepts/COM1.md", "reference/conin$.md", "reference/CLOCK$.md"]) {
			expect(guard(denied), denied).not.toBeNull();
		}
	});

	test("only markdown is written: shortcuts and shell files are refused", () => {
		for (const denied of [
			"reference/x.url",
			"reference/x.library-ms",
			"reference/x.searchConnector-ms",
			"reference/x.scf",
			"reference/x.lnk",
			"reference/x.json",
			"reference/x.md.url",
			"reference/x",
			"reference/x.md:hidden",
			"reference/x.txt:stream.md",
		]) {
			expect(guard(denied), denied).not.toBeNull();
		}
	});

	test("anything outside the three folders, or outside the vault, is refused", () => {
		for (const denied of ["brain/Memories.md", "CLAUDE.md", "work/active/x.md", "brain/x.md", "../outside.md", "D:\\vault\\reference\\x.md", "reference"]) {
			expect(guard(denied), denied).not.toBeNull();
		}
	});

	test("ordinary notes under the three folders still pass", () => {
		for (const allowed of [
			"reference/sources/Ok.md",
			"reference/sources/A talk (2026).md",
			"brain/concepts/Hook pattern.MD",
			"thinking/skill-drafts/hook-pattern/SKILL.md",
			"thinking/skill-drafts/hook-pattern/examples/one.md",
			"C:\\vault\\reference\\sources\\Ok.md",
		]) {
			expect(guard(allowed), allowed).toBeNull();
		}
	});

	test("where a write really lands is checked with the same segment rules", () => {
		const real: RealPath = (p) => p.replace(/reference\\sources\\linked/i, "reference\\.claude");
		expect(writePathRefusal(vault, "reference/sources/linked/x.md", real)).toMatch(/\.claude/);
	});
});

describe("feed write rules: UNC paths are refused without touching the disk", () => {
	const unc = ["//host/share/x.md", "\\\\host\\share\\x.md", "\\/host/share", "/\\host\\share", "\\\\?\\C:\\vault\\reference\\x.md", "\\\\.\\pipe\\x", "\\\\?\\UNC\\host\\share\\x.md"];

	test("refused before any path is resolved", () => {
		for (const target of unc) {
			const real = vi.fn<RealPath>((p) => p);
			expect(writePathRefusal(vault, target, real), target).not.toBeNull();
			expect(real, target).not.toHaveBeenCalled();
		}
	});

	test("a path outside the vault is refused lexically, before any path is resolved", () => {
		const real = vi.fn<RealPath>((p) => p);
		expect(writePathRefusal(vault, "D:\\vault\\reference\\x.md", real)).not.toBeNull();
		expect(real).not.toHaveBeenCalled();
	});

	test("a path inside the vault is still resolved (links are followed)", () => {
		const real = vi.fn<RealPath>((p) => p);
		expect(writePathRefusal(vault, "reference/sources/x.md", real)).toBeNull();
		expect(real).toHaveBeenCalled();
	});
});
