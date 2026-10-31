import { execFile } from "node:child_process";
import { SAFE_GIT } from "../../../runner/src/executor.ts";

export type GitResult = { ok: boolean; output: string };
export type GitRunner = (args: readonly string[]) => Promise<GitResult>;

const PUSH_ATTEMPTS = 3;
const LOCAL_TIMEOUT_MS = 120_000;
export const NETWORK_TIMEOUT_MS = 30_000;
const NETWORK_COMMANDS = new Set(["push", "pull", "fetch"]);
const COMMIT_PREFIX = "phone: ";

export function createGit(vault: string): GitRunner {
	return (args) =>
		new Promise((resolve) => {
			const timeout = NETWORK_COMMANDS.has(args[0] ?? "") ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
			execFile("git", [...SAFE_GIT, ...args], { cwd: vault, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) =>
				resolve({ ok: !error, output: `${stdout}${stderr}`.trim() }),
			);
		});
}

type FailedCommit = { paths: readonly string[]; message: string };
export type CommitOutcome = { committed: boolean; error?: string };

/** Space-separated fields before the path in each `git status --porcelain=v2` entry kind. */
const V2_FIELDS: Readonly<Record<string, number>> = { "1": 8, "2": 9, u: 10, "?": 1 };

/**
 * The paths in `git status --porcelain=v2 -z` output (v2: every entry starts
 * with its kind, so the runner's trim cannot eat a leading status column).
 * A rename's second (original) path is skipped.
 */
function changedPaths(output: string): string[] {
	const entries = output.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i]!;
		const fields = V2_FIELDS[entry[0] ?? ""];
		if (fields === undefined) continue;
		const parts = entry.split(" ");
		const file = parts.slice(fields).join(" ");
		if (file) paths.push(file);
		if (entry[0] === "2") i += 1;
	}
	return paths;
}

/**
 * Commits phone captures to the vault clone and pushes them. A commit is never
 * dropped: a failed push leaves it local for `retryPending`.
 *
 * Two queues. Local index work (add, commit, rebase, status) runs one at a
 * time in `serial`, and is quick. Network work (push, fetch) runs one at a
 * time in `network` and may take minutes when GitHub is down, so a commit
 * never waits for it: a push only reads refs, which a concurrent commit
 * updates atomically. A rebase always runs from inside the network queue
 * (and the local one), so it never overlaps a push.
 */
export class GitSync {
	private readonly git: GitRunner;
	private pending = 0;
	private lastError: string | null = null;
	private failedCommits: FailedCommit[] = [];
	private queue: Promise<unknown> = Promise.resolve();
	private networkQueue: Promise<unknown> = Promise.resolve();
	private queuedPush: Promise<boolean> | null = null;
	private writes = 0;

	constructor(deps: { vault: string; git?: GitRunner }) {
		this.git = deps.git ?? createGit(deps.vault);
	}

	state(): { pending: number; lastError: string | null } {
		return { pending: this.pending, lastError: this.lastError };
	}

	/** Settles once the local git work queued so far is done (shutdown waits for it: a killed commit leaves index.lock behind). */
	idle(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	/** Reads the unpushed-commit count from git. Call at startup so `state()` is accurate after a restart. */
	refresh(): Promise<boolean> {
		return this.serial(() => this.refreshPending());
	}

	pull(): Promise<boolean> {
		return this.network(() => this.pullRebase());
	}

	/** Commits the paths locally; never touches the network. A failed commit is kept for `retryPending`. */
	commit(paths: readonly string[], message: string): Promise<CommitOutcome> {
		return this.serial(async () => {
			const outcome = await this.commitPaths(paths, message);
			if (outcome.error !== undefined) this.failedCommits = [...this.failedCommits, { paths, message }];
			return outcome;
		});
	}

	/** A push of everything committed so far. Calls made while one is still waiting to start share it. */
	pushSoon(): Promise<boolean> {
		if (this.queuedPush) return this.queuedPush;
		const queued = this.network(() => {
			this.queuedPush = null;
			return this.pushWithRetry();
		});
		this.queuedPush = queued;
		return queued;
	}

	/** Commit, then wait for the push (tests and tools; request paths use `commit` and `pushSoon`). */
	async commitAndPush(paths: readonly string[], message: string): Promise<{ committed: boolean; pushed: boolean; error?: string }> {
		const outcome = await this.commit(paths, message);
		if (outcome.error !== undefined) return { committed: false, pushed: false, error: outcome.error };
		return { committed: outcome.committed, pushed: await this.pushSoon() };
	}

	retryPending(): Promise<boolean> {
		return this.network(async () => {
			if (!(await this.serial(() => this.retryFailedCommits()))) return false;
			if (!(await this.refreshPending())) return false;
			if (this.pending === 0) return true;
			return this.pushWithRetry();
		});
	}

	/**
	 * Marks a write into the clone in progress (file written, commit not yet
	 * made): `recoverUncommitted` leaves the clone alone meanwhile, so it never
	 * commits a half-written note or one whose own commit is about to come.
	 */
	async writing<T>(task: () => Promise<T>): Promise<T> {
		this.writes += 1;
		try {
			return await task();
		} finally {
			this.writes -= 1;
		}
	}

	/**
	 * Commits every new or changed file in `folders`: notes written by a run
	 * that stopped before committing them. Only the service writes to this
	 * clone, so anything uncommitted there is its own. Skipped while a write
	 * is in progress.
	 */
	recoverUncommitted(folders: readonly string[]): Promise<{ committed: number; error?: string }> {
		return this.serial(async () => {
			if (this.writes > 0) return { committed: 0 };
			const status = await this.git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ...folders]);
			if (!status.ok) return { committed: 0, error: this.fail(status.output).error ?? "git status failed" };
			const paths = changedPaths(status.output);
			if (paths.length === 0) return { committed: 0 };
			const outcome = await this.commitPaths(paths, `recover ${paths.length} notes`);
			if (outcome.error !== undefined) return { committed: 0, error: outcome.error };
			return { committed: outcome.committed ? paths.length : 0 };
		});
	}

	/** Runs local git operations one at a time, so concurrent captures never interleave index writes. */
	private serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** Runs network operations (and the rebases between them) one at a time. */
	private network<T>(task: () => Promise<T>): Promise<T> {
		const run = this.networkQueue.then(task, task);
		this.networkQueue = run.catch(() => undefined);
		return run;
	}

	private async retryFailedCommits(): Promise<boolean> {
		const remaining: FailedCommit[] = [];
		for (const entry of this.failedCommits) {
			const outcome = await this.commitPaths(entry.paths, entry.message);
			if (outcome.error !== undefined) remaining.push(entry);
		}
		this.failedCommits = remaining;
		return remaining.length === 0;
	}

	private async commitPaths(paths: readonly string[], message: string): Promise<CommitOutcome> {
		if (paths.length === 0) return { committed: false };
		const add = await this.git(["add", "--", ...paths]);
		if (!add.ok) return this.fail(add.output);
		const staged = await this.git(["diff", "--cached", "--quiet", "--", ...paths]);
		if (staged.ok) return { committed: false };
		const commit = await this.git(["commit", "-m", `${COMMIT_PREFIX}${message}`, "--", ...paths]);
		if (!commit.ok) return this.fail(commit.output);
		await this.refreshPending();
		return { committed: true };
	}

	private fail(output: string): CommitOutcome {
		const error = output || "git failed";
		this.lastError = error;
		return { committed: false, error };
	}

	/** Fetch (network), then rebase onto the upstream (local, in the index queue). Call from the network queue. */
	private async pullRebase(): Promise<boolean> {
		const fetched = await this.git(["fetch", "--quiet"]);
		if (!fetched.ok) {
			this.lastError = fetched.output || "git fetch failed";
			return false;
		}
		return this.serial(async () => {
			const result = await this.git(["rebase", "--autostash"]);
			if (!result.ok) {
				await this.git(["rebase", "--abort"]);
				this.lastError = result.output || "git rebase failed";
			}
			return result.ok;
		});
	}

	/** Call from the network queue. */
	private async pushWithRetry(): Promise<boolean> {
		for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt += 1) {
			const push = await this.git(["push"]);
			if (push.ok) {
				this.lastError = null;
				await this.refreshPending();
				return true;
			}
			this.lastError = push.output || "git push failed";
			if (attempt < PUSH_ATTEMPTS - 1) await this.pullRebase();
		}
		const error = this.lastError;
		await this.refreshPending();
		this.lastError = error;
		return false;
	}

	/** False (with lastError set) when git cannot count unpushed commits, e.g. no upstream or detached HEAD. */
	private async refreshPending(): Promise<boolean> {
		const count = await this.git(["rev-list", "--count", "@{u}..HEAD"]);
		const parsed = Number.parseInt(count.output, 10);
		if (!count.ok || !Number.isFinite(parsed)) {
			this.lastError = count.output || "cannot count unpushed commits";
			return false;
		}
		this.pending = parsed;
		return true;
	}
}
