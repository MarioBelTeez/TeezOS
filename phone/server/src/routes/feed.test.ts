import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobFolders } from "../../../../src/main/feed/live.ts";
import type { Completion } from "../../../../src/main/feed/engines/service.ts";
import { loadConfig } from "../config.ts";
import { createGit, GitSync } from "../git-sync.ts";
import { createPhoneServer } from "../http.ts";
import { feedRoute, type FeedRouteDeps } from "./feed.ts";

const headers = { "tailscale-user-login": "owner@github", "content-type": "application/json" };
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
let root: string;
let origin: string;
let vault: string;
let dataDir: string;
let server: Server;
let base: string;
let readSource: ReturnType<typeof vi.fn>;
let complete: ReturnType<typeof vi.fn>;
let sync: GitSync;
/** While set, a push waits for it (GitHub down). */
let pushGate: Promise<void> | null = null;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}
function configure(dir: string): void {
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "commit.gpgsign", "false");
	git(dir, "config", "core.autocrlf", "false");
}

const answer = (concepts: unknown[]): Completion => ({
	ok: true,
	engine: "gemini",
	model: "test",
	text: JSON.stringify({ title: "Tiny Habits", summary: "A summary of the article.", keyPoints: [{ text: "Start small" }], quotes: [], concepts, skill: null }),
});

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "phone-feed-"));
	origin = path.join(root, "origin.git");
	const seed = path.join(root, "seed");
	vault = path.join(root, "vault");
	dataDir = path.join(root, "data");
	await mkdir(dataDir, { recursive: true });
	git(root, "init", "--bare", "-b", "main", origin);
	git(root, "clone", "-c", "core.autocrlf=false", origin, seed);
	configure(seed);
	git(seed, "checkout", "-b", "main");
	await mkdir(path.join(seed, "brain", "concepts"), { recursive: true });
	await writeFile(path.join(seed, "brain", "concepts", "Habit Loop.md"), "# Habit Loop\n\nOriginal text.\n");
	git(seed, "add", "--", "brain");
	git(seed, "commit", "-m", "init");
	git(seed, "push", "-u", "origin", "main");
	git(root, "clone", "-c", "core.autocrlf=false", origin, vault);
	configure(vault);

	readSource = vi.fn(async () => ({ ok: true as const, text: "Article body about habits." }));
	complete = vi.fn(async () => answer([{ name: "Habit Loop", definition: "A cue, a routine and a reward.", isNew: false }, { name: "Anchor Moment", definition: "A fixed moment to hang a habit on.", isNew: true }]));
	pushGate = null;
	const real = createGit(vault);
	sync = new GitSync({
		vault,
		git: async (args) => {
			if (args[0] === "push" && pushGate) await pushGate;
			return real(args);
		},
	});
	const deps: FeedRouteDeps = {
		vault,
		dataDir,
		sync,
		readSource: readSource as never,
		complete: complete as never,
		workDir: jobFolders(path.join(root, "work")),
		groqKey: () => null,
		now: () => NOW,
	};
	await mkdir(path.join(root, "work"), { recursive: true });
	server = createPhoneServer(loadConfig({ TEEZ_PHONE_LOGIN: "owner@github" }), [feedRoute(deps)]);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
	// The background push, finished before the folder goes (unless the test holds it forever).
	if (!pushGate) await sync.pushSoon();
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const post = (body: unknown) => fetch(`${base}/api/feed`, { method: "POST", headers, body: JSON.stringify(body) });
type ListedItem = { id: string; status: string; title: string; error: string | null };
async function list(): Promise<ListedItem[]> {
	return ((await (await fetch(`${base}/api/feed`, { headers })).json()) as { items: ListedItem[] }).items;
}
async function settled(): Promise<ListedItem[]> {
	for (let i = 0; i < 200; i += 1) {
		const items = await list();
		if (items.length > 0 && items.every((item) => item.status === "done" || item.status === "failed")) return items;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("feed did not settle");
}

describe("feed route", () => {
	it("files an article as new notes and pushes them", async () => {
		const response = await post({ url: "https://example.com/habits" });
		expect(response.status).toBe(202);
		const { id } = (await response.json()) as { id: string };
		const items = await settled();
		expect(items[0]).toMatchObject({ id, status: "done", title: "Tiny Habits", error: null });
		const sources = await readdir(path.join(vault, "reference", "sources"));
		expect(sources).toEqual(["Tiny Habits.md"]);
		expect(await readdir(path.join(vault, "brain", "concepts"))).toContain("Anchor Moment.md");
		expect(git(vault, "log", "-1", "--format=%s")).toBe("phone: feed Tiny Habits");
		await vi.waitFor(() => expect(git(root, "--git-dir", origin, "log", "-1", "--format=%s", "main")).toBe("phone: feed Tiny Habits"), { timeout: 10_000 });
		const saved = JSON.parse(await readFile(path.join(dataDir, "feed.json"), "utf8")) as unknown[];
		expect(saved).toHaveLength(1);
	});

	it("finishes the item once committed locally, without waiting for a push that hangs", async () => {
		pushGate = new Promise(() => undefined);
		await post({ url: "https://example.com/habits" });
		const items = await settled();
		expect(items[0]).toMatchObject({ status: "done", error: null });
		expect(git(vault, "log", "-1", "--format=%s")).toBe("phone: feed Tiny Habits");
		expect(git(root, "--git-dir", origin, "log", "-1", "--format=%s", "main")).toBe("init");
	});

	it("never appends to an existing concept", async () => {
		await post({ url: "https://example.com/habits" });
		await settled();
		expect(await readFile(path.join(vault, "brain", "concepts", "Habit Loop.md"), "utf8")).toBe("# Habit Loop\n\nOriginal text.\n");
		const source = await readFile(path.join(vault, "reference", "sources", "Tiny Habits.md"), "utf8");
		expect(source).toContain("## To merge into existing notes");
		expect(source).toContain("A cue, a routine and a reward.");
	});

	it("refuses a non-http url and a body with both url and text", async () => {
		expect((await post({ url: "file:///etc/passwd" })).status).toBe(400);
		expect((await post({ url: "ftp://example.com/a" })).status).toBe(400);
		expect((await post({ url: `https://example.com/${"a".repeat(2100)}` })).status).toBe(400);
		expect((await post({ url: "https://example.com/a", text: "hello" })).status).toBe(400);
		expect((await post({})).status).toBe(400);
		expect((await post({ url: "https://example.com/a", kind: "nope" })).status).toBe(400);
		expect(readSource).not.toHaveBeenCalled();
	});

	it("a second share of the same link writes nothing", async () => {
		await post({ url: "https://example.com/habits" });
		await settled();
		const before = git(vault, "rev-parse", "HEAD");
		await post({ url: "https://example.com/habits" });
		for (let i = 0; i < 200 && (await list()).filter((item) => item.status === "done").length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
		expect(complete).toHaveBeenCalledTimes(1);
		expect(readSource).toHaveBeenCalledTimes(1);
		expect(git(vault, "rev-parse", "HEAD")).toBe(before);
		expect(await readdir(path.join(vault, "reference", "sources"))).toEqual(["Tiny Habits.md"]);
	});

	it("reads shared text without fetching a page", async () => {
		const response = await post({ text: "My own pasted notes about habits." });
		expect(response.status).toBe(202);
		const items = await settled();
		expect(items[0]?.status).toBe("done");
		expect(readSource).not.toHaveBeenCalled();
		expect(String(complete.mock.calls[0]?.[1] && JSON.stringify(complete.mock.calls[0][1]))).toContain("My own pasted notes");
	});
});
