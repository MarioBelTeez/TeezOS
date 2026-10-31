import { describe, expect, test } from "vitest";
import { posix, win32 } from "node:path";
import { resolveInside, toRelative } from "./guard.ts";

/**
 * The guard is the only thing standing between a renderer request and the
 * disk. Every case here is a way a path has been used to escape a folder.
 */

const WIN_ROOT = "C:\\Users\\user\\Projects\\teezai";
const POSIX_ROOT = "/home/user/teezai";

describe("resolveInside, Windows", () => {
	const inside = (rel: string) => resolveInside(WIN_ROOT, rel, win32);

	test("the root itself", () => {
		expect(inside("")).toEqual({ ok: true, path: WIN_ROOT });
	});

	test("a nested file with forward slashes", () => {
		expect(inside("src/main/index.ts")).toEqual({
			ok: true,
			path: `${WIN_ROOT}\\src\\main\\index.ts`,
		});
	});

	test("backslashes are accepted too", () => {
		expect(inside("src\\main")).toEqual({ ok: true, path: `${WIN_ROOT}\\src\\main` });
	});

	test.each([
		["parent traversal", "../secrets.txt"],
		["traversal in the middle", "src/../../outside"],
		["backslash traversal", "src\\..\\..\\outside"],
		["an absolute path", "C:\\Windows\\System32"],
		["another drive", "D:\\data"],
		["a drive-relative path", "C:foo"],
		["a UNC share", "\\\\server\\share\\file"],
		["the device namespace", "\\\\?\\C:\\Windows"],
		["a rooted path", "\\Windows"],
		["an NTFS alternate stream", "notes.txt:hidden"],
		["an 8.3 short name", "PROGRA~1/thing"],
		["a NUL byte", "file\0.txt"],
	])("rejects %s", (_label, rel) => {
		expect(inside(rel).ok).toBe(false);
	});

	test("a sibling folder sharing the root's prefix is outside", () => {
		// C:\...\teezai-evil starts with C:\...\teezai but is not inside it.
		expect(resolveInside(WIN_ROOT, "../teezai-evil/x", win32).ok).toBe(false);
	});

	test("a name that merely contains dots is fine", () => {
		expect(inside("a..b/file.test.ts").ok).toBe(true);
	});

	test("non-strings are rejected", () => {
		expect(resolveInside(WIN_ROOT, 42 as unknown as string, win32).ok).toBe(false);
	});
});

describe("resolveInside, Linux", () => {
	const inside = (rel: string) => resolveInside(POSIX_ROOT, rel, posix);

	test("a nested file", () => {
		expect(inside("src/a.ts")).toEqual({ ok: true, path: "/home/user/teezai/src/a.ts" });
	});

	test.each([
		["parent traversal", "../x"],
		["an absolute path", "/etc/passwd"],
		["a NUL byte", "a\0b"],
	])("rejects %s", (_label, rel) => {
		expect(inside(rel).ok).toBe(false);
	});

	test("colons and tildes are legal file names on Linux", () => {
		expect(inside("notes:2026.md").ok).toBe(true);
		expect(inside("backup~1").ok).toBe(true);
	});
});

describe("toRelative", () => {
	test("gives forward slashes for a path inside the root", () => {
		expect(toRelative(WIN_ROOT, `${WIN_ROOT}\\src\\main\\index.ts`, win32)).toBe(
			"src/main/index.ts",
		);
	});

	test("is null for a path outside", () => {
		expect(toRelative(WIN_ROOT, "C:\\Windows", win32)).toBeNull();
	});

	test("is case-insensitive on Windows", () => {
		expect(toRelative(WIN_ROOT, "c:\\users\\user\\projects\\teezai\\README.md", win32)).toBe(
			"README.md",
		);
	});
});
