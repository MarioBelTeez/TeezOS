import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatus, readGitStatus, readHeadFile } from "./git.ts";

describe("parseStatus", () => {
	test("reads branch, upstream and ahead/behind", () => {
		const raw = [
			"# branch.oid 1a2b3c",
			"# branch.head main",
			"# branch.upstream origin/main",
			"# branch.ab +2 -1",
			"",
		].join("\0");
		expect(parseStatus(raw)).toMatchObject({
			branch: "main",
			upstream: "origin/main",
			ahead: 2,
			behind: 1,
			files: {},
		});
	});

	test("maps each entry kind to the letter the tree shows", () => {
		const raw = [
			"# branch.head main",
			"1 .M N... 100644 100644 100644 aaa aaa src/changed.ts",
			"1 A. N... 000000 100644 100644 000 bbb src/new.ts",
			"1 D. N... 100644 000000 000000 ccc 000 gone.ts",
			"2 R. N... 100644 100644 100644 ddd ddd R100 renamed.ts",
			"old-name.ts",
			"u UU N... 100644 100644 100644 100644 e f g both.ts",
			"? untracked.txt",
			"? new-folder/",
			"",
		].join("\0");
		expect(parseStatus(raw).files).toEqual({
			"src/changed.ts": "M",
			"src/new.ts": "A",
			"gone.ts": "D",
			"renamed.ts": "R",
			"both.ts": "C",
			"untracked.txt": "U",
			"new-folder/": "U",
		});
	});

	test("a detached head says so", () => {
		expect(parseStatus("# branch.head (detached)\0").branch).toBe("(detached)");
	});

	test("paths with spaces survive (that is why -z is used)", () => {
		const raw = "1 .M N... 100644 100644 100644 a a Proxmox Homelab Server.md\0";
		expect(parseStatus(raw).files).toEqual({ "Proxmox Homelab Server.md": "M" });
	});
});

describe("against a real repository", () => {
	let repo: string;
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "teez-git-"));
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "Test");
		git("config", "commit.gpgsign", "false");
		writeFileSync(join(repo, "a.txt"), "one\n");
		writeFileSync(join(repo, "b.txt"), "two\n");
		git("add", ".");
		git("commit", "-q", "-m", "init");
		writeFileSync(join(repo, "a.txt"), "one changed\n");
		renameSync(join(repo, "b.txt"), join(repo, "c.txt"));
		mkdirSync(join(repo, "sub dir"));
		writeFileSync(join(repo, "sub dir", "note.md"), "x\n");
	});

	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	test("readGitStatus reports the working tree", async () => {
		const status = await readGitStatus(repo);
		expect(status).not.toBeNull();
		expect(status?.branch).toBe("main");
		expect(status?.files["a.txt"]).toBe("M");
		expect(status?.files["b.txt"]).toBe("D");
		expect(status?.files["c.txt"]).toBe("U");
		expect(status?.files["sub dir/"]).toBe("U");
	});

	test("readHeadFile returns the committed version", async () => {
		expect(await readHeadFile(repo, "a.txt")).toBe("one\n");
		expect(await readHeadFile(repo, "c.txt")).toBeNull();
	});

	test("a folder that is not a repository gives null, not a throw", async () => {
		const plain = mkdtempSync(join(tmpdir(), "teez-plain-"));
		try {
			expect(await readGitStatus(plain)).toBeNull();
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});
