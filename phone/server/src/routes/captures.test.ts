import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitSync, type GitRunner } from "../git-sync.ts";
import { createCaptures } from "./captures.ts";

const NOW = new Date(2026, 9, 17, 14, 5).getTime();
let dir: string;
let vault: string;
let dataDir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "phone-cap-"));
	vault = path.join(dir, "vault");
	dataDir = path.join(dir, "data");
	await mkdir(vault, { recursive: true });
	await mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

type Call = readonly string[];
function fakeGit(opts: { pushOk: boolean; commitOk?: boolean; pushHangs?: boolean; commitGate?: Promise<void> }): { git: GitRunner; calls: Call[] } {
	const calls: Call[] = [];
	const git: GitRunner = async (args) => {
		calls.push(args);
		switch (args[0]) {
			case "diff":
				return { ok: false, output: "" };
			case "commit":
				if (opts.commitGate) await opts.commitGate;
				return { ok: opts.commitOk ?? true, output: "" };
			case "push":
				if (opts.pushHangs) await new Promise(() => undefined);
				return { ok: opts.pushOk, output: opts.pushOk ? "" : "rejected" };
			case "rev-list":
				return { ok: true, output: opts.pushOk ? "0" : "1" };
			default:
				return { ok: true, output: "" };
		}
	};
	return { git, calls };
}

function make(git: GitRunner) {
	const sync = new GitSync({ vault, git });
	return createCaptures({ vault, dataDir, sync, now: () => NOW });
}

/** Generous: the suite runs in parallel with 140 other files. */
const WAIT = { timeout: 5000 };
const readLog = async (): Promise<Record<string, unknown>[]> => JSON.parse(await readFile(path.join(dataDir, "captures.json"), "utf8"));

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

/** A real clone of a bare origin in `vault`, for the recovery tests. */
async function realVault(): Promise<string> {
	const origin = path.join(dir, "origin.git");
	git(dir, "init", "--bare", "-b", "main", origin);
	git(dir, "clone", "-q", "-c", "core.autocrlf=false", origin, vault);
	for (const [key, value] of [
		["user.name", "Test"],
		["user.email", "test@example.com"],
		["commit.gpgsign", "false"],
	] as const)
		git(vault, "config", key, value);
	git(vault, "checkout", "-q", "-b", "main");
	await writeFile(path.join(vault, "README.md"), "vault\n");
	git(vault, "add", "--", "README.md");
	git(vault, "commit", "-q", "-m", "init");
	git(vault, "push", "-q", "-u", "origin", "main");
	return origin;
}

const within = <T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> => Promise.race([promise, new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), ms))]);

describe("captures", () => {
	it("saves a capture, commits it locally, answers before the push and marks it synced once pushed", async () => {
		const { git: fake, calls } = fakeGit({ pushOk: true });
		const captures = make(fake);
		const saved = await captures.saveCapture("Remember the milk run tomorrow morning please", []);
		expect(saved.synced).toBe(false);
		expect(saved.path).toBe("thinking/phone-2026-10-17-1405-Remember the milk run tomorrow morning.md");
		expect(existsSync(path.join(vault, saved.path))).toBe(true);
		const commit = calls.find((c) => c[0] === "commit");
		expect(commit?.[2]).toBe("phone: capture Remember the milk run tomorrow morning");
		await vi.waitFor(async () => expect((await readLog())[0]).toMatchObject({ path: saved.path, committed: true, synced: true }), WAIT);
	});

	it("answers at once with synced false while the push hangs, the capture committed locally", async () => {
		const { git: fake, calls } = fakeGit({ pushOk: true, pushHangs: true });
		const captures = make(fake);
		const saved = await within(captures.saveCapture("GitHub is down today", []), 5000);
		expect(saved).toMatchObject({ synced: false });
		expect(calls.some((c) => c[0] === "commit")).toBe(true);
		expect((await readLog())[0]).toMatchObject({ committed: true, synced: false });
	});

	it("logs the capture as not committed before it commits", async () => {
		let open: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const captures = make(fakeGit({ pushOk: true, commitGate: gate }).git);
		const saving = captures.saveCapture("logged first", []);
		await vi.waitFor(async () => expect((await readLog())[0]).toMatchObject({ title: "logged first", committed: false, synced: false }), WAIT);
		open();
		await saving;
		expect((await readLog())[0]).toMatchObject({ committed: true });
	});

	it("refuses an empty or oversized capture", async () => {
		const captures = make(fakeGit({ pushOk: true }).git);
		await expect(captures.saveCapture("   ", [])).rejects.toMatchObject({ status: 400 });
		await expect(captures.saveCapture("x".repeat(4001), [])).rejects.toMatchObject({ status: 400 });
	});

	it("reports synced false when the push fails, and the file is on disk", async () => {
		const captures = make(fakeGit({ pushOk: false }).git);
		const saved = await captures.saveCapture("offline thought", []);
		expect(saved.synced).toBe(false);
		expect(existsSync(path.join(vault, saved.path))).toBe(true);
	});

	it("commits, at startup, a capture whose commit failed in the previous run", async () => {
		const origin = await realVault();
		const failing = createCaptures({ vault, dataDir, sync: new GitSync({ vault, git: fakeGit({ pushOk: true, commitOk: false }).git }), now: () => NOW });
		const saved = await failing.saveCapture("needs retry", []);
		expect(saved.synced).toBe(false);
		const restarted = createCaptures({ vault, dataDir, sync: new GitSync({ vault }), now: () => NOW });
		await restarted.recover();
		expect(git(vault, "status", "--porcelain")).toBe("");
		expect(git(vault, "log", "-1", "--format=%s")).toBe("phone: recover 1 notes");
		await vi.waitFor(async () => expect((await readLog())[0]).toMatchObject({ committed: true, synced: true }), WAIT);
		expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("phone: recover 1 notes");
	});

	it("commits, at startup, a capture written but neither logged nor committed (a crash in between)", async () => {
		await realVault();
		await mkdir(path.join(vault, "thinking"), { recursive: true });
		await writeFile(path.join(vault, "thinking", "phone-2026-10-17-1405-crashed.md"), "---\nprovenance: phone\n---\n\ncrashed\n");
		await writeFile(path.join(vault, "stray.md"), "not the service's folder\n");
		const sync = new GitSync({ vault });
		const captures = createCaptures({ vault, dataDir, sync, now: () => NOW });
		await captures.recover();
		expect(git(vault, "log", "-1", "--format=%s")).toBe("phone: recover 1 notes");
		expect(git(vault, "status", "--porcelain")).toBe("?? stray.md");
		// The background push, done before the folder is removed.
		expect(await sync.pushSoon()).toBe(true);
	});

	it("commits, at startup and on a retry tick, feed notes left uncommitted", async () => {
		await realVault();
		await mkdir(path.join(vault, "reference", "sources"), { recursive: true });
		await mkdir(path.join(vault, "brain", "concepts"), { recursive: true });
		await writeFile(path.join(vault, "reference", "sources", "An Article.md"), "source\n");
		await writeFile(path.join(vault, "brain", "concepts", "Habit Loop.md"), "concept\n");
		const sync = new GitSync({ vault });
		const captures = createCaptures({ vault, dataDir, sync, now: () => NOW });
		await captures.recover();
		expect(git(vault, "log", "-1", "--format=%s")).toBe("phone: recover 2 notes");
		await writeFile(path.join(vault, "brain", "concepts", "Anchor Moment.md"), "concept\n");
		await captures.retry();
		expect(git(vault, "log", "-1", "--format=%s")).toBe("phone: recover 1 notes");
		expect(git(vault, "status", "--porcelain")).toBe("");
		expect(await sync.pushSoon()).toBe(true);
	});

	it("marks committed captures synced once retryPending succeeds", async () => {
		const first = make(fakeGit({ pushOk: false }).git);
		await first.saveCapture("pending push", []);
		const second = make(fakeGit({ pushOk: true }).git);
		await second.retry();
		expect((await readLog())[0]!["synced"]).toBe(true);
	});

	it("lists the last 20 from the log", async () => {
		const captures = make(fakeGit({ pushOk: true }).git);
		await writeFile(
			path.join(dataDir, "captures.json"),
			JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ path: `thinking/p${i}.md`, title: `t${i}`, date: "2026-10-17", committed: true, synced: true }))),
		);
		const result = await captures.route({ method: "GET" } as never, new URL("http://x/api/captures"));
		const body = result?.body as { path: string }[];
		expect(body).toHaveLength(20);
		expect(body[19]?.path).toBe("thinking/p24.md");
	});

	it("does not run two recoveries at once", async () => {
		const sync = new GitSync({ vault, git: fakeGit({ pushOk: true }).git });
		const spy = vi.spyOn(sync, "recoverUncommitted");
		const captures = createCaptures({ vault, dataDir, sync, now: () => NOW });
		await Promise.all([captures.recover(), captures.recover()]);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("submits a failed commit once per process, not once per retry tick", async () => {
		const sync = new GitSync({ vault, git: fakeGit({ pushOk: true, commitOk: false }).git });
		const spy = vi.spyOn(sync, "commit");
		const captures = createCaptures({ vault, dataDir, sync, now: () => NOW });
		await captures.saveCapture("never commits", []);
		await captures.retry();
		await captures.retry();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("keeps a corrupt log aside and still saves", async () => {
		await writeFile(path.join(dataDir, "captures.json"), "{not json");
		const captures = make(fakeGit({ pushOk: true }).git);
		await captures.saveCapture("fresh start", []);
		const files = await readdir(dataDir);
		const aside = files.find((f) => f.startsWith("captures.json.corrupt-"));
		expect(aside).toBeDefined();
		expect(await readFile(path.join(dataDir, aside!), "utf8")).toBe("{not json");
		expect(JSON.parse(await readFile(path.join(dataDir, "captures.json"), "utf8"))).toHaveLength(1);
	});

	it("writes model captures with provenance phone-chat, the user's own with provenance phone", async () => {
		const captures = make(fakeGit({ pushOk: true }).git);
		const own = await captures.saveCapture("my own thought", []);
		const model = await captures.saveCapture("something the reply kept", ["Note A"], { provenance: "phone-chat" });
		expect(await readFile(path.join(vault, own.path), "utf8")).toContain("provenance: phone\n");
		expect(await readFile(path.join(vault, model.path), "utf8")).toContain("provenance: phone-chat\n");
	});
});
