import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { Executor, asJobUser, claudeArgs, READ_ONLY_TOOLS, SAFE_GIT } from "./executor.ts";
import { Store, validateJob } from "./store.ts";
import type { Job, Run } from "./types.ts";

function fakeClaude(lines: unknown[], code = 0): ChildProcess {
	const child = new EventEmitter() as ChildProcess & EventEmitter;
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	Object.assign(child, { stdout, stderr, kill: () => true });
	setTimeout(() => {
		stdout.end(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		setTimeout(() => child.emit("close", code), 10);
	}, 5);
	return child;
}

const waitForEnd = (executor: Executor, run: Run): Promise<Run> =>
	new Promise((resolve) => executor.events.once(`end:${run.id}`, resolve));

describe("Executor", () => {
	let dir: string;
	let store: Store;
	let job: Job;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "teez-runner-"));
		store = new Store(dir);
		job = store.createJob(
			validateJob({ name: "Daily", prompt: "Summarise", cwd: "/home/agent/work/TeezMind", schedule: "0 8 * * *", commitMessage: "vault: daily (runner)" }, "/home/agent/work"),
		);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("a successful run keeps Claude's events, its result, and commits what changed", async () => {
		const gitCalls: string[] = [];
		const executor = new Executor({
			store,
			claudePath: "claude",
			claudeToken: () => "sk-test",
			spawn: () =>
				fakeClaude([
					{ type: "system", subtype: "hook_started" },
					{ type: "system", subtype: "init", session_id: "s1" },
					{ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
					{ type: "result", subtype: "success", result: "Done.", total_cost_usd: 0.02, is_error: false },
				]),
			git: async (_cwd, args) => {
				gitCalls.push(args.join(" "));
				if (args[0] === "status") return { ok: true, output: " M Home.md" };
				if (args[0] === "commit") return { ok: true, output: "[main abc123] vault: daily (runner)" };
				return { ok: true, output: "" };
			},
		});
		const started = executor.start(job, "manual");
		const ended = await waitForEnd(executor, started);

		expect(ended).toMatchObject({ status: "ok", result: "Done.", costUsd: 0.02, git: "committed and pushed" });
		expect(gitCalls).toEqual(["status --porcelain", "add -A", "commit -m vault: daily (runner)", "push"]);
		const kinds = store.events(started.id).map((e) => (e.data as { type: string }).type);
		// hook_started is dropped; the runner's own notes are kept.
		expect(kinds).toEqual(["runner", "system", "assistant", "result", "runner", "runner"]);
		expect(store.run(started.id)?.status).toBe("ok");
	});

	test("no token means a clear error, not a hung run", async () => {
		const executor = new Executor({ store, claudePath: "claude", claudeToken: () => null, spawn: () => fakeClaude([]) });
		const ended = await waitForEnd(executor, executor.start(job, "schedule"));
		expect(ended.status).toBe("error");
		expect(ended.error).toContain("No Claude token");
	});

	test("a failed Claude run reports stderr and does not commit", async () => {
		const gitCalls: string[] = [];
		const executor = new Executor({
			store,
			claudePath: "claude",
			claudeToken: () => "t",
			spawn: () => {
				const child = fakeClaude([], 1);
				setTimeout(() => (child.stderr as PassThrough).write("Invalid API key"), 1);
				return child;
			},
			git: async (_c, args) => {
				gitCalls.push(args.join(" "));
				return { ok: true, output: "" };
			},
		});
		const ended = await waitForEnd(executor, executor.start(job, "manual"));
		expect(ended.status).toBe("error");
		expect(ended.error).toContain("Invalid API key");
		expect(gitCalls).toEqual([]);
	});

	test("one run per job at a time", async () => {
		const executor = new Executor({ store, claudePath: "claude", claudeToken: () => "t", spawn: () => fakeClaude([], 0), git: async () => ({ ok: true, output: "" }) });
		const first = executor.start(job, "manual");
		expect(() => executor.start(job, "manual")).toThrow(/already running/);
		await waitForEnd(executor, first);
	});
});

describe("Executor with Antigravity", () => {
	let dir: string;
	let store: Store;
	const cwd = "/home/agent/work/TeezMind";
	const agyJob = (permission: Job["permission"] = "read-only", name = "Digest"): Job =>
		store.createJob(validateJob({ name, prompt: "Summarise", cwd, engine: "antigravity", permission }, "/home/agent/work"));
	const ok = (response: string, extra: Record<string, unknown> = {}): unknown[] => [
		{ event: "init", conversation_id: "c1", init: { cwd, tools: [], permission_mode: "request-review" } },
		{ event: "step_update", step_update: { conversation_id: "c1", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: response } },
		{ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response, duration_seconds: 3, num_turns: 1, ...extra } },
	];
	const agyDeps = (overrides: Partial<ConstructorParameters<typeof Executor>[0]> = {}): ConstructorParameters<typeof Executor>[0] => ({
		store,
		claudePath: "claude",
		claudeToken: () => null,
		agyPath: () => "agy",
		writeAgyRules: async () => ({ ok: true, output: "" }),
		spawn: () => fakeClaude(ok("done")),
		...overrides,
	});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "teez-runner-"));
		store = new Store(dir);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("writes the job's rules before starting agy, needs no Claude token, keeps the reply", async () => {
		const order: string[] = [];
		const spawned: string[][] = [];
		const executor = new Executor(
			agyDeps({
				agyPath: () => "/home/agent/.local/bin/agy",
				writeAgyRules: async (rules) => {
					order.push(`rules deny=${rules.deny.join(",")}`);
					return { ok: true, output: "" };
				},
				spawn: (file, args) => {
					order.push("spawn");
					spawned.push([file, ...args]);
					return fakeClaude(ok("Three notes changed."));
				},
			}),
		);
		const ended = await waitForEnd(executor, executor.start(agyJob(), "manual"));
		expect(ended).toMatchObject({ status: "ok", result: "Three notes changed.", costUsd: 0 });
		expect(order[0]).toContain("write_file(*)");
		expect(order[1]).toBe("spawn");
		expect(spawned[0]).toEqual(["/home/agent/.local/bin/agy", "--output-format", "stream-json", "-p=Summarise"]);
		const kinds = store.events(ended.id).map((e) => (e.data as { event?: string; type?: string }).event ?? (e.data as { type: string }).type);
		expect(kinds).toEqual(["runner", "init", "step_update", "result"]);
	});

	test("agy not installed: a clear error", async () => {
		const executor = new Executor(agyDeps({ agyPath: () => null }));
		const ended = await waitForEnd(executor, executor.start(agyJob(), "manual"));
		expect(ended.status).toBe("error");
		expect(ended.error).toMatch(/Antigravity is not installed/);
	});

	test("rules that cannot be written stop the run before agy starts", async () => {
		let spawned = false;
		const executor = new Executor(
			agyDeps({
				writeAgyRules: async () => ({ ok: false, output: "EACCES" }),
				spawn: () => {
					spawned = true;
					return fakeClaude([]);
				},
			}),
		);
		const ended = await waitForEnd(executor, executor.start(agyJob(), "manual"));
		expect(ended.status).toBe("error");
		expect(ended.error).toMatch(/permission rules.*EACCES/);
		expect(spawned).toBe(false);
	});

	test("a status other than SUCCESS is an error", async () => {
		const executor = new Executor(agyDeps({ spawn: () => fakeClaude([{ event: "result", result: { status: "ERROR", error: "quota exhausted" } }]) }));
		const ended = await waitForEnd(executor, executor.start(agyJob(), "manual"));
		expect(ended.status).toBe("error");
		expect(ended.error).toContain("quota exhausted");
	});

	test("a refused action with no reply is an error, not an empty success", async () => {
		const executor = new Executor(agyDeps({ spawn: () => fakeClaude(ok("", { denied_actions: [{ action: "command", display_name: "Run command" }] })) }));
		const ended = await waitForEnd(executor, executor.start(agyJob(), "manual"));
		expect(ended.status).toBe("error");
		expect(ended.error).toMatch(/refused.*Run command/);
	});

	test("a refused action alongside a reply keeps the reply and notes the refusal", async () => {
		const executor = new Executor(agyDeps({ spawn: () => fakeClaude(ok("Partial answer.", { denied_actions: [{ action: "read_url" }] })) }));
		const ended = await waitForEnd(executor, executor.start(agyJob(), "manual"));
		expect(ended).toMatchObject({ status: "ok", result: "Partial answer." });
		const notes = store.events(ended.id).filter((e) => (e.data as { type?: string }).type === "runner").map((e) => (e.data as { text: string }).text);
		expect(notes.some((t) => /refused.*read_url/.test(t))).toBe(true);
	});

	test("two Antigravity runs never overlap: the rules file is shared", async () => {
		const timeline: string[] = [];
		const executor = new Executor(
			agyDeps({
				writeAgyRules: async (rules) => {
					timeline.push(`rules:${rules.allow.length ? "research" : "read-only"}`);
					return { ok: true, output: "" };
				},
				spawn: () => {
					timeline.push("spawn");
					const child = fakeClaude(ok("done"));
					child.on("close", () => timeline.push("close"));
					return child;
				},
			}),
		);
		const first = executor.start(agyJob("read-only", "A"), "manual");
		const second = executor.start(agyJob("research", "B"), "manual");
		await Promise.all([waitForEnd(executor, first), waitForEnd(executor, second)]);
		expect(timeline).toEqual(["rules:read-only", "spawn", "close", "rules:research", "spawn", "close"]);
		const waited = store.events(second.id).some((e) => /waiting/i.test(String((e.data as { text?: string }).text ?? "")));
		expect(waited).toBe(true);
	});

	test("cancelled while waiting for the other Antigravity run: ends at once and never starts", async () => {
		let spawns = 0;
		const executor = new Executor(
			agyDeps({
				spawn: () => {
					spawns += 1;
					return fakeClaude(ok("done"));
				},
			}),
		);
		const first = executor.start(agyJob("read-only", "A"), "manual");
		const second = executor.start(agyJob("read-only", "B"), "manual");
		await new Promise((r) => setTimeout(r, 1));
		const secondEnd = waitForEnd(executor, second);
		executor.cancel(second.id);
		const endedSecond = await secondEnd;
		expect(endedSecond.status).toBe("cancelled");
		expect(executor.isRunning(first.jobId)).toBe(true);
		await waitForEnd(executor, first);
		expect(spawns).toBe(1);
	});

	describe("with a process that never exits", () => {
		const hung = (): ChildProcess => {
			const child = new EventEmitter() as ChildProcess & EventEmitter;
			Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
			return child;
		};
		const settle = async (ms: number): Promise<void> => {
			for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
			await vi.advanceTimersByTimeAsync(ms);
			for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
		};
		beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
		afterEach(() => vi.useRealTimers());

		test("an abandoned run hands the turn on, so the next Antigravity run still starts", async () => {
			const children = [hung(), null];
			const executor = new Executor(agyDeps({ spawn: () => children.shift() ?? fakeClaude(ok("second done")) }));
			const first = executor.start(agyJob("read-only", "A"), "manual");
			const second = executor.start(agyJob("read-only", "B"), "manual");
			await settle(0);
			const firstEnd = waitForEnd(executor, first);
			const secondEnd = waitForEnd(executor, second);
			executor.cancel(first.id);
			await settle(16_000); // SIGTERM, SIGKILL after 10 s, abandoned 5 s later
			expect((await firstEnd).status).toBe("cancelled");
			await settle(100);
			expect(await secondEnd).toMatchObject({ status: "ok", result: "second done" });
		});

		test("waiting for the turn counts against the job's time limit", async () => {
			let spawns = 0;
			const executor = new Executor(
				agyDeps({
					spawn: () => {
						spawns += 1;
						return hung();
					},
				}),
			);
			const long = executor.start(agyJob("read-only", "Long"), "manual");
			const short = executor.start(
				store.createJob(validateJob({ name: "Short", prompt: "p", cwd, engine: "antigravity", timeoutMinutes: 1 }, "/home/agent/work")),
				"manual",
			);
			const shortEnd = waitForEnd(executor, short);
			await settle(61_000);
			expect((await shortEnd).status).toBe("timeout");
			expect(spawns).toBe(1);
			executor.cancel(long.id);
			await settle(16_000);
		});
	});
});

describe("git settings guard", () => {
	let work: string;
	let store: Store;
	beforeEach(() => {
		work = mkdtempSync(join(tmpdir(), "teez-work-"));
		mkdirSync(join(work, "repo", ".git"), { recursive: true });
		writeFileSync(join(work, "repo", ".git", "config"), "[core]\n\tbare = false\n");
		store = new Store(mkdtempSync(join(tmpdir(), "teez-runner-")));
	});
	afterEach(() => rmSync(work, { recursive: true, force: true }));

	test("a job that changes .git/config gets it put back, fails, and commits nothing", async () => {
		const gitCalls: string[] = [];
		const restored: { file: string; content: string | null }[] = [];
		const job = store.createJob({ ...validateJob({ name: "Edit", prompt: "p", cwd: "/home/agent/work/repo", commitMessage: "x", permission: "edit" }, "/home/agent/work"), cwd: join(work, "repo") });
		const executor = new Executor({
			store,
			claudePath: "claude",
			claudeToken: () => "t",
			spawn: () => {
				writeFileSync(join(work, "repo", ".git", "config"), "[core]\n\tsshCommand = evil\n");
				return fakeClaude([{ type: "result", subtype: "success", result: "Done.", total_cost_usd: 0, is_error: false }]);
			},
			restoreFile: async (file, content) => {
				restored.push({ file, content });
				return { ok: true, output: "" };
			},
			git: async (_c, args) => {
				gitCalls.push(args.join(" "));
				return { ok: true, output: "" };
			},
		});
		const ended = await waitForEnd(executor, executor.start(job, "manual"));
		expect(ended.status).toBe("error");
		expect(ended.error).toContain(".git/config");
		expect(restored).toEqual([{ file: join(work, "repo", ".git", "config"), content: "[core]\n\tbare = false\n" }]);
		expect(gitCalls).toEqual([]);
	});

	test("a file the job added under .git/info is removed again", async () => {
		const restored: { file: string; content: string | null }[] = [];
		const job = store.createJob({ ...validateJob({ name: "Edit", prompt: "p", cwd: "/home/agent/work/repo", permission: "edit" }, "/home/agent/work"), cwd: join(work, "repo") });
		const executor = new Executor({
			store,
			claudePath: "claude",
			claudeToken: () => "t",
			spawn: () => {
				mkdirSync(join(work, "repo", ".git", "info"), { recursive: true });
				writeFileSync(join(work, "repo", ".git", "info", "attributes"), "* filter=x\n");
				return fakeClaude([{ type: "result", subtype: "success", result: "Done.", total_cost_usd: 0, is_error: false }]);
			},
			restoreFile: async (file, content) => {
				restored.push({ file, content });
				return { ok: true, output: "" };
			},
		});
		const ended = await waitForEnd(executor, executor.start(job, "manual"));
		expect(ended.status).toBe("error");
		expect(restored).toEqual([{ file: join(work, "repo", ".git", "info", "attributes"), content: null }]);
	});
});

describe("SAFE_GIT", () => {
	test("overrides the repository settings that would run a program", () => {
		const flags = SAFE_GIT.join(" ");
		for (const setting of ["core.fsmonitor=false", "core.hooksPath=/dev/null", "core.sshCommand=ssh", "core.pager=cat", "protocol.ext.allow=never", "credential.helper=", "diff.external="]) {
			expect(flags).toContain(setting);
		}
	});
});

describe("claudeArgs", () => {
	test("read-only jobs get only reading tools", () => {
		const job = { prompt: "x", model: "", permission: "read-only" } as Job;
		const args = claudeArgs(job);
		expect(args).toContain("--allowedTools");
		expect(args[args.indexOf("--allowedTools") + 1]).toBe(READ_ONLY_TOOLS.join(","));
		expect(args).not.toContain("bypassPermissions");
		expect(args.join(" ")).not.toMatch(/\bBash\b|\bWrite\b|\bEdit\b/);
	});

	test("full jobs bypass permissions; edit jobs accept edits", () => {
		expect(claudeArgs({ prompt: "x", model: "opus", permission: "full" } as Job)).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions", "--model", "opus"]));
		expect(claudeArgs({ prompt: "x", model: "", permission: "edit" } as Job)).toEqual(expect.arrayContaining(["acceptEdits"]));
	});
});

describe("asJobUser", () => {
	test("runs as the job user through sudo, changing folder as that user", () => {
		expect(asJobUser("agent", "/home/agent/work/TeezMind", "claude", ["-p", "--", "hi"], ["CLAUDE_CODE_OAUTH_TOKEN"])).toEqual({
			file: "sudo",
			args: ["-n", "-H", "-u", "agent", "--preserve-env=CLAUDE_CODE_OAUTH_TOKEN", "--", "env", "-C", "/home/agent/work/TeezMind", "claude", "-p", "--", "hi"],
			cwd: "/",
		});
	});

	test("without a job user, runs directly", () => {
		expect(asJobUser(undefined, "/w", "git", ["status"])).toEqual({ file: "git", args: ["status"], cwd: "/w" });
	});
});

describe("claudeArgs ordering", () => {
	test("the prompt comes after --, so a leading dash is text", () => {
		const args = claudeArgs({ prompt: "--dangerously-skip-permissions do it", model: "", permission: "read-only" } as Job);
		expect(args.slice(-2)).toEqual(["--", "--dangerously-skip-permissions do it"]);
	});

	test("read-only has no web; research does", () => {
		const readOnly = claudeArgs({ prompt: "x", model: "", permission: "read-only" } as Job).join(" ");
		const research = claudeArgs({ prompt: "x", model: "", permission: "research" } as Job).join(" ");
		expect(readOnly).not.toContain("WebFetch");
		expect(research).toContain("WebFetch");
	});
});

describe("validateJob", () => {
	test("folders must stay inside the work directory", () => {
		expect(() => validateJob({ name: "x", prompt: "p", cwd: "/etc" }, "/home/agent/work")).toThrow(/inside/);
		expect(() => validateJob({ name: "x", prompt: "p", cwd: "/home/agent/work/../../etc" }, "/home/agent/work")).toThrow(/inside/);
	});

	test("engine defaults to Claude; Antigravity is kept; anything else is Claude", () => {
		const base = { name: "x", prompt: "p", cwd: "/home/agent/work" };
		expect(validateJob(base, "/home/agent/work").engine).toBe("claude");
		expect(validateJob({ ...base, engine: "antigravity" }, "/home/agent/work").engine).toBe("antigravity");
		expect(validateJob({ ...base, engine: "gpt" }, "/home/agent/work").engine).toBe("claude");
	});

	test("an edit that leaves out the engine keeps the job's engine", () => {
		const base = { name: "x", prompt: "p", cwd: "/home/agent/work" };
		expect(validateJob(base, "/home/agent/work", { engine: "antigravity" }).engine).toBe("antigravity");
		expect(validateJob({ ...base, engine: "claude" }, "/home/agent/work", { engine: "antigravity" }).engine).toBe("claude");
	});

	test("model ids start with a letter or digit and stay short", () => {
		const base = { name: "x", prompt: "p", cwd: "/home/agent/work" };
		expect(validateJob({ ...base, model: "gemini-3.8-flash-high" }, "/home/agent/work").model).toBe("gemini-3.8-flash-high");
		expect(validateJob({ ...base, model: "--dangerously-skip-permissions" }, "/home/agent/work").model).toBe("");
		expect(validateJob({ ...base, model: "a".repeat(81) }, "/home/agent/work").model).toBe("");
	});

	test("a bad schedule is refused with the reason", () => {
		expect(() => validateJob({ name: "x", prompt: "p", cwd: "/home/agent/work", schedule: "0 25 * * *" }, "/home/agent/work")).toThrow(/out of range/);
	});
});
