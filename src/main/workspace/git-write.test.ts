import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitPaths } from "./git-write.ts";
import { readGitStatus } from "./git.ts";
import { searchWorkspace } from "./search.ts";

describe("commit and search in a real repository", () => {
	let repo: string;
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "teez-gitw-"));
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "Test");
		git("config", "commit.gpgsign", "false");
		writeFileSync(join(repo, "a.txt"), "alpha\n");
		git("add", ".");
		git("commit", "-q", "-m", "init");
	});

	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	test("commits only the ticked files and leaves the rest alone", async () => {
		writeFileSync(join(repo, "a.txt"), "alpha changed\n");
		writeFileSync(join(repo, "someone-elses.md"), "work in progress\n");

		const result = await commitPaths(repo, ["a.txt"], "vault: change a");
		expect(result.ok).toBe(true);
		expect(git("log", "-1", "--format=%s").trim()).toBe("vault: change a");
		const status = await readGitStatus(repo);
		expect(status?.files).toEqual({ "someone-elses.md": "U" });
	});

	test("refuses an empty message, no files, and paths outside", async () => {
		expect((await commitPaths(repo, ["a.txt"], "  ")).ok).toBe(false);
		expect((await commitPaths(repo, [], "msg")).ok).toBe(false);
		expect((await commitPaths(repo, ["../x"], "msg")).ok).toBe(false);
	});

	test("search finds tracked and untracked text, case-insensitive by default", async () => {
		writeFileSync(join(repo, "notes.md"), "line one\nThe ALPHA plan\n");
		const hits = await searchWorkspace(repo, "alpha", { caseSensitive: false, regex: false });
		expect(hits).toEqual(
			expect.arrayContaining([
				{ path: "a.txt", line: 1, text: "alpha" },
				{ path: "notes.md", line: 2, text: "The ALPHA plan" },
			]),
		);
		const exact = await searchWorkspace(repo, "ALPHA", { caseSensitive: true, regex: false });
		expect(exact.map((h) => h.path)).toEqual(["notes.md"]);
	});
});
