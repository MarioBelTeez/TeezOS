/** Shared by the runner and the TeezAI app (type-only on the app side). */

/**
 * read-only: read and search the folder. research: also the web. edit: read
 * and edit files (no web, no shell). full: every tool, shell included.
 * Web access and file reading are kept apart on purpose: a job that can read
 * and also fetch URLs has a way to send what it read somewhere.
 */
export type Permission = "read-only" | "research" | "edit" | "full";

/**
 * Who runs the job: Claude Code on the Claude subscription, or Antigravity
 * (`agy`) on the Google account's quota.
 */
export type Engine = "claude" | "antigravity";

export type Job = {
	readonly id: string;
	readonly name: string;
	readonly engine: Engine;
	/** Five-field cron, or "" for manual only. */
	readonly schedule: string;
	readonly enabled: boolean;
	/** Absolute folder on the runner, inside its work directory. */
	readonly cwd: string;
	readonly prompt: string;
	/** "" for the account default. */
	readonly model: string;
	readonly permission: Permission;
	readonly timeoutMinutes: number;
	/** `git pull --ff-only` in cwd before the run. */
	readonly gitPull: boolean;
	/** Commit whatever the run changed, with this message, and push. "" = never commit. */
	readonly commitMessage: string;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type JobInput = Omit<Job, "id" | "createdAt" | "updatedAt">;

export type RunStatus = "running" | "ok" | "error" | "cancelled" | "timeout";

export type Run = {
	readonly id: string;
	readonly jobId: string;
	readonly jobName: string;
	readonly trigger: "schedule" | "manual";
	readonly status: RunStatus;
	readonly startedAt: number;
	readonly endedAt: number | null;
	readonly result: string;
	readonly costUsd: number;
	readonly error: string;
	/** What git did after the run: "", "no changes", "committed abc123", "pushed", or the failure. */
	readonly git: string;
};

export type Health = {
	readonly ok: true;
	readonly version: string;
	readonly hostname: string;
	readonly timezone: string;
	readonly claude: { readonly installed: boolean; readonly version: string; readonly hasToken: boolean };
	/** `loggedIn` and `models` come from `agy models`, which needs a working login. */
	readonly antigravity: {
		readonly installed: boolean;
		readonly version: string;
		readonly loggedIn: boolean;
		readonly models: readonly { readonly id: string; readonly label: string }[];
	};
	readonly workDir: string;
	readonly folders: readonly string[];
	readonly running: number;
};

/** One line of a run's log: Claude's own stream-json, or the runner's notes. */
export type RunEvent = { readonly seq: number; readonly at: number; readonly data: unknown };
