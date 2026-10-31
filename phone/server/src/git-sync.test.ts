import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, GitSync } from "./git-sync.ts";

let root: string;
let origin: string;
let phone: string;
let other: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

function configure(dir: string): void {
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "commit.gpgsign", "false");
	git(dir, "config", "core.autocrlf", "false");
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "phone-git-"));
	origin = path.join(root, "origin.git");
	phone = path.join(root, "phone");
	other = path.join(root, "other");
	git(root, "init", "--bare", "-b", "main", origin);
	git(root, "clone", "-c", "core.autocrlf=false", origin, other);
	configure(other);
	git(other, "checkout", "-b", "main");
	await writeFile(path.join(other, "README.md"), "vault\n");
	git(other, "add", "--", "README.md");
	git(other, "commit", "-m", "init");
	git(other, "push", "-u", "origin", "main");
	git(root, "clone", "-c", "core.autocrlf=false", origin, phone);
	configure(phone);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("GitSync", () => {
	it("commits only the given paths and pushes", async () => {
		await writeFile(path.join(phone, "a.md"), "a\n");
		await writeFile(path.join(phone, "stray.md"), "stray\n");
		const sync = new GitSync({ vault: phone });
		const result = await sync.commitAndPush(["a.md"], "capture a");
		expect(result).toEqual({ committed: true, pushed: true });
		expect(git(phone, "log", "-1", "--format=%s")).toBe("phone: capture a");
		expect(git(phone, "status", "--porcelain")).toBe("?? stray.md");
		expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("phone: capture a");
		expect(sync.state()).toEqual({ pending: 0, lastError: null });
	});

	it("rebases over a commit pushed by another machine and pushes", async () => {
		await writeFile(path.join(other, "theirs.md"), "theirs\n");
		git(other, "add", "--", "theirs.md");
		git(other, "commit", "-m", "other machine");
		git(other, "push");
		await writeFile(path.join(phone, "mine.md"), "mine\n");
		const sync = new GitSync({ vault: phone });
		const result = await sync.commitAndPush(["mine.md"], "capture mine");
		expect(result).toEqual({ committed: true, pushed: true });
		expect(await readFile(path.join(phone, "theirs.md"), "utf8")).toBe("theirs\n");
		const files = git(origin, "ls-tree", "--name-only", "main").split("\n");
		expect(files).toEqual(expect.arrayContaining(["mine.md", "theirs.md"]));
	});

	it("keeps the commit and pushes it on retry", async () => {
		const moved = path.join(root, "origin-away.git");
		await rename(origin, moved);
		await writeFile(path.join(phone, "kept.md"), "kept\n");
		const sync = new GitSync({ vault: phone });
		const result = await sync.commitAndPush(["kept.md"], "capture kept");
		expect(result).toEqual({ committed: true, pushed: false });
		expect(sync.state().pending).toBe(1);
		expect(sync.state().lastError).not.toBeNull();
		await rename(moved, origin);
		expect(await sync.retryPending()).toBe(true);
		expect(sync.state()).toEqual({ pending: 0, lastError: null });
		expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("phone: capture kept");
	});

	it("does not commit when the paths have no changes", async () => {
		const sync = new GitSync({ vault: phone });
		expect(await sync.commitAndPush(["README.md"], "nothing")).toEqual({ committed: false, pushed: true });
	});

	it("pull brings in other machines' commits", async () => {
		await writeFile(path.join(other, "new.md"), "n\n");
		git(other, "add", "--", "new.md");
		git(other, "commit", "-m", "n");
		git(other, "push");
		expect(await new GitSync({ vault: phone }).pull()).toBe(true);
		expect(await readFile(path.join(phone, "new.md"), "utf8")).toBe("n\n");
	});

	it("sees unpushed commits from before a restart after refresh", async () => {
		await writeFile(path.join(phone, "old.md"), "old\n");
		git(phone, "add", "--", "old.md");
		git(phone, "commit", "-m", "phone: before restart");
		const sync = new GitSync({ vault: phone });
		expect(await sync.refresh()).toBe(true);
		expect(sync.state().pending).toBe(1);
		expect(await sync.retryPending()).toBe(true);
		expect(sync.state().pending).toBe(0);
		expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("phone: before restart");
	});

	it("retryPending fails with lastError when there is no upstream", async () => {
		git(phone, "checkout", "-b", "lonely");
		const sync = new GitSync({ vault: phone });
		expect(await sync.retryPending()).toBe(false);
		expect(sync.state().lastError).not.toBeNull();
	});

	it("reports a failed commit and recommits it on retry", async () => {
		const real = createGit(phone);
		let failed = false;
		const flaky = async (args: readonly string[]) => {
			if (args[0] === "commit" && !failed) {
				failed = true;
				return { ok: false, output: "boom" };
			}
			return real(args);
		};
		await writeFile(path.join(phone, "flaky.md"), "f\n");
		const sync = new GitSync({ vault: phone, git: flaky });
		const result = await sync.commitAndPush(["flaky.md"], "capture flaky");
		expect(result).toEqual({ committed: false, pushed: false, error: "boom" });
		expect(await sync.retryPending()).toBe(true);
		expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("phone: capture flaky");
		expect(sync.state()).toEqual({ pending: 0, lastError: null });
	});

	it("commit records locally and never pushes", async () => {
		await writeFile(path.join(phone, "local.md"), "l\n");
		const sync = new GitSync({ vault: phone });
		expect(await sync.commit(["local.md"], "capture local")).toEqual({ committed: true });
		expect(git(phone, "log", "-1", "--format=%s")).toBe("phone: capture local");
		expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("init");
		expect(sync.state().pending).toBe(1);
		expect(await sync.pushSoon()).toBe(true);
		expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("phone: capture local");
	});

	it("a commit does not wait for a push that hangs", async () => {
		const real = createGit(phone);
		let release: () => void = () => undefined;
		const hanging = async (args: readonly string[]) => {
			if (args[0] === "push") await new Promise<void>((resolve) => (release = resolve));
			return real(args);
		};
		const sync = new GitSync({ vault: phone, git: hanging });
		await writeFile(path.join(phone, "one.md"), "1\n");
		await sync.commit(["one.md"], "one");
		const pushing = sync.pushSoon();
		await writeFile(path.join(phone, "two.md"), "2\n");
		const second = await Promise.race([sync.commit(["two.md"], "two"), new Promise((resolve) => setTimeout(() => resolve("waited"), 5000))]);
		expect(second).toEqual({ committed: true });
		release();
		await pushing;
	});

	it("recoverUncommitted commits new and changed notes in the given folders only", async () => {
		await writeFile(path.join(other, "seed.md"), "s\n");
		await mkdir(path.join(phone, "brain", "concepts"), { recursive: true });
		await writeFile(path.join(phone, "brain", "concepts", "Old.md"), "old\n");
		git(phone, "add", "--", "brain/concepts/Old.md");
		git(phone, "commit", "-m", "old concept");
		await mkdir(path.join(phone, "thinking"), { recursive: true });
		await mkdir(path.join(phone, "reference", "sources"), { recursive: true });
		await writeFile(path.join(phone, "thinking", "phone-lost.md"), "lost\n");
		await writeFile(path.join(phone, "reference", "sources", "Feed Source.md"), "src\n");
		await writeFile(path.join(phone, "brain", "concepts", "Old.md"), "changed\n");
		await writeFile(path.join(phone, "stray.md"), "stray\n");
		const sync = new GitSync({ vault: phone });
		expect(await sync.recoverUncommitted(["thinking", "reference/sources", "brain/concepts"])).toEqual({ committed: 3 });
		expect(git(phone, "log", "-1", "--format=%s")).toBe("phone: recover 3 notes");
		expect(git(phone, "status", "--porcelain")).toBe("?? stray.md");
		expect(await sync.recoverUncommitted(["thinking", "reference/sources", "brain/concepts"])).toEqual({ committed: 0 });
	});

	it("recoverUncommitted leaves files alone while a write is in progress", async () => {
		await mkdir(path.join(phone, "thinking"), { recursive: true });
		const sync = new GitSync({ vault: phone });
		let finish: () => void = () => undefined;
		const writing = sync.writing(async () => {
			await writeFile(path.join(phone, "thinking", "half.md"), "half\n");
			await new Promise<void>((resolve) => (finish = resolve));
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await sync.recoverUncommitted(["thinking"])).toEqual({ committed: 0 });
		finish();
		await writing;
		expect(await sync.recoverUncommitted(["thinking"])).toEqual({ committed: 1 });
	});

	it("idle settles once the local work queued before it is done", async () => {
		await writeFile(path.join(phone, "idle.md"), "i\n");
		const sync = new GitSync({ vault: phone });
		const committing = sync.commit(["idle.md"], "idle");
		let committed = false;
		void committing.then(() => (committed = true));
		await sync.idle();
		expect(committed).toBe(true);
	});
});
