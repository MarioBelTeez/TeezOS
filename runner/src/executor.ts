import { execFile, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import { WRITE_RULES_SCRIPT, agyArgs, agyRules, uncheckedTools, type AgyRules } from "./agy.ts";
import { RESTORE_SCRIPT, changedGitFiles, snapshotGitFiles } from "./git-guard.ts";
import type { Store } from "./store.ts";
import type { Job, Permission, Run, RunEvent } from "./types.ts";

/**
 * Runs a job: optionally `git pull`, then the agent headless in the job's
 * folder — Claude Code (`claude -p`) or Antigravity (`agy -p`), both as
 * stream-json — then optionally commit and push what it changed. Every line
 * the agent prints is kept as a run event, so the app can show a run exactly
 * like a chat.
 *
 * A headless agent cannot ask for permission, so the job's permission level
 * decides up front which tools it may use: read-only by default.
 */

export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "LS", "TodoWrite"];
const RESEARCH_TOOLS = [...READ_ONLY_TOOLS, "WebSearch", "WebFetch"];
const EDIT_TOOLS = [...READ_ONLY_TOOLS, "Edit", "MultiEdit", "Write", "NotebookEdit"];

const TOOLS: Readonly<Record<Exclude<Permission, "full">, readonly string[]>> = {
	"read-only": READ_ONLY_TOOLS,
	research: RESEARCH_TOOLS,
	edit: EDIT_TOOLS,
};

/** Every git call the runner makes: no repository-configured programs, no hooks. */
export const SAFE_GIT = [
	"-c", "core.fsmonitor=false",
	"-c", "core.hooksPath=/dev/null",
	// Settings a repository could set to make git run a program (see git-guard.ts).
	"-c", "core.sshCommand=ssh",
	"-c", "core.pager=cat",
	"-c", "core.askPass=",
	"-c", "credential.helper=",
	"-c", "diff.external=",
	"-c", "protocol.ext.allow=never",
];

const MAX_EVENTS_PER_RUN = 20_000;
const KILL_GRACE_MS = 10_000;

export function claudeArgs(job: Job): string[] {
	const permission: Permission = job.permission;
	return [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		...(job.model ? ["--model", job.model] : []),
		...(permission === "full"
			? ["--permission-mode", "bypassPermissions"]
			: ["--permission-mode", permission === "edit" ? "acceptEdits" : "default", "--allowedTools", TOOLS[permission].join(",")]),
		// "--" ends the options (and --allowedTools' list): a prompt starting
		// with "-" is text, never a flag.
		"--",
		job.prompt,
	];
}

/**
 * Run a command as the job user. The service runs as `runner`, which alone can
 * read the API token, the TLS key and the Claude token; jobs run as `agent`,
 * so even a "full" job cannot read the secrets that would let it give itself
 * more. `env -C` changes into the job's folder as that user.
 */
export function asJobUser(user: string | undefined, cwd: string, file: string, args: readonly string[], keepEnv: readonly string[] = []): { file: string; args: string[]; cwd: string } {
	if (!user) return { file, args: [...args], cwd };
	return {
		file: "sudo",
		args: ["-n", "-H", "-u", user, ...(keepEnv.length ? [`--preserve-env=${keepEnv.join(",")}`] : []), "--", "env", "-C", cwd, file, ...args],
		cwd: "/",
	};
}

type Spawn = (file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export type ExecutorDeps = {
	readonly store: Store;
	readonly claudePath: string;
	/** The account jobs run as (via sudo); unset runs them as this process. */
	readonly jobUser?: string;
	readonly claudeToken: () => string | null;
	/** agy's path for the job account, or null when it is not installed. */
	readonly agyPath?: () => string | null;
	/** Writes agy's allow/deny rules before a run; by default WRITE_RULES_SCRIPT as the job user. */
	readonly writeAgyRules?: (rules: AgyRules) => Promise<{ ok: boolean; output: string }>;
	/** Writes (or, for null, removes) a file as the job user; used to put git's settings back. */
	readonly restoreFile?: (file: string, content: string | null) => Promise<{ ok: boolean; output: string }>;
	readonly spawn?: Spawn;
	readonly git?: (cwd: string, args: readonly string[]) => Promise<{ ok: boolean; output: string }>;
	readonly maxConcurrent?: number;
};

function makeGit(jobUser: string | undefined) {
	return (cwd: string, args: readonly string[]): Promise<{ ok: boolean; output: string }> =>
		new Promise((resolve) => {
			const command = asJobUser(jobUser, cwd, "git", [...SAFE_GIT, ...args]);
			execFile(command.file, command.args, { cwd: command.cwd, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) =>
				resolve({ ok: !error, output: `${stdout}${stderr}`.trim() }),
			);
		});
}

function makeWriteAgyRules(jobUser: string | undefined) {
	return (rules: AgyRules): Promise<{ ok: boolean; output: string }> =>
		new Promise((resolve) => {
			const command = asJobUser(jobUser, "/", process.execPath, ["-e", WRITE_RULES_SCRIPT, JSON.stringify(rules)]);
			execFile(command.file, command.args, { cwd: command.cwd, timeout: 30_000 }, (error, stdout, stderr) =>
				resolve({ ok: !error, output: `${stdout}${stderr}`.trim() || (error ? error.message : "") }),
			);
		});
}

function makeRestoreFile(jobUser: string | undefined) {
	return (file: string, content: string | null): Promise<{ ok: boolean; output: string }> =>
		new Promise((resolve) => {
			const command = asJobUser(jobUser, "/", process.execPath, ["-e", RESTORE_SCRIPT, file, JSON.stringify(content)]);
			execFile(command.file, command.args, { cwd: command.cwd, timeout: 30_000 }, (error, stdout, stderr) =>
				resolve({ ok: !error, output: `${stdout}${stderr}`.trim() || (error ? error.message : "") }),
			);
		});
}

type Outcome = { readonly isError: boolean; readonly result: string; readonly costUsd: number; readonly error: string };
const EMPTY_OUTCOME: Outcome = { isError: false, result: "", costUsd: 0, error: "" };

/** A refused action as agy names it: its display name, else its kind. */
function deniedName(action: unknown): string {
	if (typeof action !== "object" || action === null) return "";
	const a = action as Record<string, unknown>;
	if (typeof a["display_name"] === "string") return a["display_name"];
	return typeof a["action"] === "string" ? a["action"] : "";
}

type Live = {
	readonly run: Run;
	child: ChildProcess | null;
	/** Ends a wait for the Antigravity turn when the run is cancelled. */
	onCancel: (() => void) | null;
	/** Ends the wait for a process that never exits, once the run is abandoned. */
	onAbandon: (() => void) | null;
	cancelled: boolean;
	timedOut: boolean;
	seq: number;
	truncated: boolean;
	killTimer: NodeJS.Timeout | null;
};

export class Executor {
	readonly #deps: ExecutorDeps;
	readonly #live = new Map<string, Live>();
	/** Antigravity runs take turns (see #runAgy): the end of the queue, and how many are in it. */
	#agyTail: Promise<void> = Promise.resolve();
	#agyHolders = 0;
	/** Emits `event:<runId>` for every new event and `end:<runId>` when a run finishes. */
	readonly events = new EventEmitter();

	constructor(deps: ExecutorDeps) {
		this.#deps = deps;
		this.events.setMaxListeners(100);
	}

	get running(): number {
		return this.#live.size;
	}

	isRunning(jobId: string): boolean {
		return [...this.#live.values()].some((live) => live.run.jobId === jobId);
	}

	start(job: Job, trigger: Run["trigger"]): Run {
		if (this.isRunning(job.id)) throw new Error("This job is already running.");
		if (this.#live.size >= (this.#deps.maxConcurrent ?? 2)) throw new Error("Too many runs at once; try again in a moment.");
		const run: Run = {
			id: randomUUID(),
			jobId: job.id,
			jobName: job.name,
			trigger,
			status: "running",
			startedAt: Date.now(),
			endedAt: null,
			result: "",
			costUsd: 0,
			error: "",
			git: "",
		};
		this.#deps.store.saveRun(run);
		const live: Live = { run, child: null, onCancel: null, onAbandon: null, cancelled: false, timedOut: false, seq: 0, truncated: false, killTimer: null };
		this.#live.set(run.id, live);
		// Start on the next tick, so the caller can subscribe to the run first.
		setImmediate(() => {
			void this.#execute(job, live).catch((error: unknown) => this.#finish(live, { status: "error", error: String(error) }));
		});
		return run;
	}

	cancel(runId: string): boolean {
		const live = this.#live.get(runId);
		if (!live) return false;
		live.cancelled = true;
		live.onCancel?.();
		this.#stop(live);
		return true;
	}

	/**
	 * SIGTERM, then SIGKILL after a grace period, then — if the process still
	 * never closes — give the run up anyway, so a stuck child can neither keep
	 * the job from starting again nor hold a concurrency slot forever.
	 */
	#stop(live: Live): void {
		const child = live.child;
		if (!child || live.killTimer) return;
		child.kill("SIGTERM");
		live.killTimer = setTimeout(() => {
			child.kill("SIGKILL");
			live.killTimer = setTimeout(() => {
				if (!this.#live.has(live.run.id)) return;
				live.child = null;
				this.#finish(live, { status: live.timedOut ? "timeout" : "cancelled", error: "The process did not exit; the run was abandoned." });
				// Stop waiting for it, so whatever it holds (the Antigravity turn) is let go.
				live.onAbandon?.();
			}, 5000);
		}, KILL_GRACE_MS);
	}

	#emit(live: Live, data: unknown): void {
		if (live.seq >= MAX_EVENTS_PER_RUN) {
			if (!live.truncated) {
				live.truncated = true;
				const note: RunEvent = { seq: live.seq, at: Date.now(), data: { type: "runner", text: `Log truncated after ${MAX_EVENTS_PER_RUN} events.` } };
				this.#deps.store.appendEvent(live.run.id, note);
				this.events.emit(`event:${live.run.id}`, note);
			}
			return;
		}
		const event: RunEvent = { seq: live.seq, at: Date.now(), data };
		live.seq += 1;
		this.#deps.store.appendEvent(live.run.id, event);
		this.events.emit(`event:${live.run.id}`, event);
	}

	#note(live: Live, text: string): void {
		this.#emit(live, { type: "runner", text });
	}

	async #execute(job: Job, live: Live): Promise<void> {
		const git = this.#deps.git ?? makeGit(this.#deps.jobUser);
		let runAgent: () => Promise<Outcome | null>;
		if (job.engine === "antigravity") {
			const agyPath = this.#deps.agyPath?.() ?? null;
			if (!agyPath) {
				this.#finish(live, { status: "error", error: "Antigravity is not installed on the runner (agy for the job account)." });
				return;
			}
			runAgent = () => this.#runAgy(job, live, agyPath);
		} else {
			const token = this.#deps.claudeToken();
			if (!token) {
				this.#finish(live, { status: "error", error: "No Claude token on the runner. Set one from the app (Automations → Claude login)." });
				return;
			}
			runAgent = () => this.#runClaude(job, live, token);
		}

		if (job.gitPull) {
			const pulled = await git(job.cwd, ["pull", "--ff-only"]);
			this.#note(live, `git pull --ff-only: ${pulled.output || (pulled.ok ? "ok" : "failed")}`);
			if (!pulled.ok) {
				this.#finish(live, { status: "error", error: `git pull failed: ${pulled.output}` });
				return;
			}
		}
		// Cancelled while git was pulling: do not start the agent at all.
		if (live.cancelled) {
			this.#finish(live, { status: "cancelled" });
			return;
		}

		const gitBefore = snapshotGitFiles(job.cwd);
		const outcome = await runAgent();
		const gitChanged = await this.#restoreGitFiles(live, gitBefore, job.cwd);
		// The abandon path may already have closed this run.
		if (!outcome || !this.#live.has(live.run.id)) return;
		if (gitChanged.length > 0) {
			return this.#finish(live, {
				status: "error",
				result: outcome.result,
				costUsd: outcome.costUsd,
				error: `The job changed git's own settings (${gitChanged.join(", ")}). They were put back and nothing was committed.`,
			});
		}
		const { result, costUsd } = outcome;
		if (live.cancelled) return this.#finish(live, { status: "cancelled", result, costUsd });
		if (live.timedOut) return this.#finish(live, { status: "timeout", result, costUsd, error: `Stopped after ${job.timeoutMinutes} minutes.` });
		if (outcome.isError) return this.#finish(live, { status: "error", result, costUsd, error: outcome.error.slice(0, 4000) });

		let gitNote = "";
		if (job.commitMessage) gitNote = await this.#commit(job, live, git);
		this.#finish(live, { status: "ok", result, costUsd, git: gitNote });
	}

	/** Put back any of git's own settings files the agent changed; returns them, relative to the folder. */
	async #restoreGitFiles(live: Live, before: ReturnType<typeof snapshotGitFiles>, cwd: string): Promise<string[]> {
		const changed = changedGitFiles(before, snapshotGitFiles(cwd));
		const restore = this.#deps.restoreFile ?? makeRestoreFile(this.#deps.jobUser);
		const names: string[] = [];
		for (const { file, content } of changed) {
			const name = path.relative(cwd, file).replaceAll("\\", "/");
			names.push(name);
			const restored = await restore(file, content);
			const text = restored.ok ? `${name} was changed by the job; put back as it was.` : `${name} was changed by the job and could not be put back: ${restored.output}`;
			if (this.#live.has(live.run.id)) this.#note(live, text);
			else console.error(`run ${live.run.id}: ${text}`);
		}
		return names;
	}

	async #runClaude(job: Job, live: Live, token: string): Promise<Outcome | null> {
		this.#note(live, `claude ${job.permission} in ${job.cwd}${job.model ? ` · ${job.model}` : ""}`);
		const command = asJobUser(this.#deps.jobUser, job.cwd, this.#deps.claudePath, claudeArgs(job), ["CLAUDE_CODE_OAUTH_TOKEN", "CI"]);
		let result = "";
		let costUsd = 0;
		let isError = false;
		const exit = await this.#runProcess(job, live, command, { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, CI: "1" }, (message) => {
			// Hook chatter is noise in a run log, as in the app's chat.
			if (message["type"] === "system" && message["subtype"] !== "init") return false;
			if (message["type"] === "result") {
				result = typeof message["result"] === "string" ? message["result"] : "";
				costUsd = typeof message["total_cost_usd"] === "number" ? message["total_cost_usd"] : 0;
				isError = message["is_error"] === true;
			}
			return true;
		});
		if (!exit) return null;
		return { isError: exit.code !== 0 || isError, result, costUsd, error: exit.stderr || result || `claude exited with ${exit.code}` };
	}

	/**
	 * agy reads its permission rules from one settings file per account, so
	 * Antigravity runs take turns: write this job's rules, run, then the next.
	 */
	async #runAgy(job: Job, live: Live, agyPath: string): Promise<Outcome | null> {
		const release = await this.#takeAgyTurn(job, live);
		try {
			if (live.cancelled || live.timedOut) return EMPTY_OUTCOME;
			const write = this.#deps.writeAgyRules ?? makeWriteAgyRules(this.#deps.jobUser);
			const written = await write(agyRules(job.permission));
			if (!written.ok) return { ...EMPTY_OUTCOME, isError: true, error: `Could not set Antigravity's permission rules: ${written.output}` };
			if (live.cancelled) return EMPTY_OUTCOME;

			this.#note(live, `antigravity ${job.permission} in ${job.cwd}${job.model ? ` · ${job.model}` : ""}`);
			const command = asJobUser(this.#deps.jobUser, job.cwd, agyPath, agyArgs(job));
			let response = "";
			let status = "";
			let failure = "";
			let denied: string[] = [];
			const exit = await this.#runProcess(job, live, command, { ...process.env }, (message) => {
				const init = message["event"] === "init" ? message["init"] : null;
				if (job.permission !== "full" && typeof init === "object" && init !== null) {
					const tools = (init as Record<string, unknown>)["tools"];
					const unchecked = Array.isArray(tools) ? uncheckedTools(tools) : [];
					if (unchecked.length > 0) this.#note(live, `Antigravity has tools these permission rules were not checked against: ${unchecked.join(", ")}. Check what they can do before trusting this level.`);
				}
				const result = message["event"] === "result" ? message["result"] : null;
				if (typeof result === "object" && result !== null) {
					const r = result as Record<string, unknown>;
					response = typeof r["response"] === "string" ? r["response"] : "";
					status = typeof r["status"] === "string" ? r["status"] : "";
					failure = typeof r["error"] === "string" ? r["error"] : "";
					denied = Array.isArray(r["denied_actions"]) ? r["denied_actions"].map(deniedName).filter(Boolean) : [];
				}
				return true;
			});
			if (!exit) return null;
			if (denied.length > 0) this.#note(live, `Antigravity was refused: ${denied.join(", ")}. A headless run cannot ask; give the job a wider permission level if it needs that.`);
			if (exit.code !== 0 || status !== "SUCCESS") {
				return { ...EMPTY_OUTCOME, isError: true, result: response, error: failure || exit.stderr || response || `agy exited with ${exit.code}${status ? ` (${status})` : ""}` };
			}
			if (!response.trim() && denied.length > 0) return { ...EMPTY_OUTCOME, isError: true, error: `Antigravity was refused: ${denied.join(", ")}, and gave no answer.` };
			return { ...EMPTY_OUTCOME, result: response };
		} finally {
			release();
		}
	}

	/**
	 * Wait for the previous Antigravity run to end — or for this run to be
	 * cancelled, or its time limit to pass (the wait counts against it).
	 * The returned release is safe to call more than once.
	 */
	async #takeAgyTurn(job: Job, live: Live): Promise<() => void> {
		let open!: () => void;
		const mine = new Promise<void>((resolve) => (open = resolve));
		const previous = this.#agyTail;
		this.#agyTail = previous.then(() => mine);
		if (this.#agyHolders > 0) this.#note(live, "Waiting for the other Antigravity run to finish.");
		this.#agyHolders += 1;
		let timer: NodeJS.Timeout | undefined;
		await new Promise<void>((resolve) => {
			live.onCancel = resolve;
			timer = setTimeout(() => {
				live.timedOut = true;
				resolve();
			}, job.timeoutMinutes * 60_000);
			void previous.then(() => resolve());
		});
		clearTimeout(timer);
		live.onCancel = null;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#agyHolders -= 1;
			open();
		};
	}

	/**
	 * Spawn the agent, keep each stdout JSON line `accept` lets through as a
	 * run event, and enforce the job's time limit. `null` when abandoned.
	 */
	async #runProcess(
		job: Job,
		live: Live,
		command: { file: string; args: string[]; cwd: string },
		env: NodeJS.ProcessEnv,
		accept: (message: Record<string, unknown>) => boolean,
	): Promise<{ code: number | null; stderr: string } | null> {
		const spawn: Spawn = this.#deps.spawn ?? ((file, args, options) => nodeSpawn(file, [...args], { ...options, stdio: ["ignore", "pipe", "pipe"] }));
		const child = spawn(command.file, command.args, { cwd: command.cwd, env });
		live.child = child;

		const timer = setTimeout(() => {
			live.timedOut = true;
			this.#stop(live);
		}, job.timeoutMinutes * 60_000);

		const stderr: string[] = [];
		if (child.stdout) {
			const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
			lines.on("line", (line) => {
				if (!line.trim()) return;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					this.#note(live, line.slice(0, 500));
					return;
				}
				if (typeof parsed === "object" && parsed !== null && !accept(parsed as Record<string, unknown>)) return;
				this.#emit(live, parsed);
			});
		}
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr.push(String(chunk));
			if (stderr.length > 40) stderr.shift();
		});

		const code = await new Promise<number | null>((resolve) => {
			live.onAbandon = () => resolve(null);
			child.on("close", (exitCode) => resolve(exitCode));
			child.on("error", (error) => {
				stderr.push(error.message);
				resolve(null);
			});
		});
		live.onAbandon = null;
		clearTimeout(timer);
		if (live.killTimer) clearTimeout(live.killTimer);
		live.child = null;
		if (!this.#live.has(live.run.id)) return null;
		return { code, stderr: stderr.join("").trim() };
	}

	async #commit(job: Job, live: Live, git: NonNullable<ExecutorDeps["git"]>): Promise<string> {
		// This clone belongs to the runner alone, so staging everything it holds is
		// safe here — unlike a working tree shared with another agent.
		const status = await git(job.cwd, ["status", "--porcelain"]);
		if (!status.ok) return `git status failed: ${status.output}`;
		if (!status.output) {
			this.#note(live, "git: no changes to commit");
			return "no changes";
		}
		const added = await git(job.cwd, ["add", "-A"]);
		if (!added.ok) return `git add failed: ${added.output}`;
		const committed = await git(job.cwd, ["commit", "-m", job.commitMessage]);
		if (!committed.ok) return `git commit failed: ${committed.output}`;
		this.#note(live, `git commit: ${committed.output.split("\n")[0] ?? ""}`);
		let pushed = await git(job.cwd, ["push"]);
		if (!pushed.ok) {
			// Someone pushed meanwhile: replay this commit on top and try once more.
			const rebased = await git(job.cwd, ["pull", "--rebase"]);
			pushed = rebased.ok ? await git(job.cwd, ["push"]) : rebased;
		}
		this.#note(live, `git push: ${pushed.ok ? "ok" : pushed.output}`);
		return pushed.ok ? "committed and pushed" : `committed, push failed: ${pushed.output.slice(0, 300)}`;
	}

	#finish(live: Live, outcome: Partial<Run> & { readonly status: Run["status"] }): void {
		const run: Run = { ...live.run, ...outcome, endedAt: Date.now() };
		this.#deps.store.saveRun(run);
		this.#deps.store.prune(run.jobId);
		this.#live.delete(run.id);
		this.events.emit(`end:${run.id}`, run);
	}

	cancelAll(): void {
		for (const id of this.#live.keys()) this.cancel(id);
	}
}
