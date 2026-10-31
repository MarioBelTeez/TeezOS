import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseCron } from "./cron.ts";
import type { Engine, Job, JobInput, Permission, Run, RunEvent } from "./types.ts";

/**
 * Jobs and runs on disk, under the runner's data directory:
 *
 *   jobs.json             every job
 *   runs/<id>.json        a run's summary
 *   runs/<id>.ndjson      a run's events, one per line
 *
 * Writes go through a temp file and a rename, so a crash never leaves half a
 * file. Only the newest RUNS_PER_JOB runs of each job are kept.
 */

const RUNS_PER_JOB = 50;
const PERMISSIONS: readonly Permission[] = ["read-only", "research", "edit", "full"];
const ENGINES: readonly Engine[] = ["claude", "antigravity"];
const MAX_EVENTS_PER_PAGE = 2000;

/** `existing` is the job being edited: an edit that leaves the engine out keeps it. */
export function validateJob(input: unknown, workDir: string, existing?: Pick<Job, "engine">): JobInput {
	if (typeof input !== "object" || input === null) throw new Error("A job must be an object.");
	const r = input as Record<string, unknown>;
	const name = typeof r["name"] === "string" ? r["name"].trim() : "";
	if (!name || name.length > 80) throw new Error("A job needs a name (up to 80 characters).");
	const prompt = typeof r["prompt"] === "string" ? r["prompt"].trim() : "";
	if (!prompt) throw new Error("A job needs a prompt.");
	if (prompt.length > 20_000) throw new Error("The prompt is too long.");
	const schedule = typeof r["schedule"] === "string" ? r["schedule"].trim() : "";
	if (schedule) parseCron(schedule); // throws with a readable reason
	const cwd = typeof r["cwd"] === "string" ? path.posix.normalize(r["cwd"].trim()) : "";
	const root = path.posix.normalize(workDir);
	if (!(cwd === root || cwd.startsWith(`${root}/`))) throw new Error(`The folder must be inside ${root}.`);
	const engine = ENGINES.includes(r["engine"] as Engine) ? (r["engine"] as Engine) : (existing?.engine ?? "claude");
	const permission = PERMISSIONS.includes(r["permission"] as Permission) ? (r["permission"] as Permission) : "read-only";
	// Starts with a letter or digit, so it can never read as a flag.
	const model = typeof r["model"] === "string" && /^(?:[A-Za-z0-9][\w.-]{0,79})?$/.test(r["model"]) ? r["model"] : "";
	const timeout = typeof r["timeoutMinutes"] === "number" && Number.isFinite(r["timeoutMinutes"]) ? Math.round(r["timeoutMinutes"]) : 20;
	const commitMessage = typeof r["commitMessage"] === "string" ? r["commitMessage"].trim().slice(0, 200) : "";
	return {
		name,
		engine,
		schedule,
		enabled: r["enabled"] !== false,
		cwd,
		prompt,
		model,
		permission,
		timeoutMinutes: Math.min(240, Math.max(1, timeout)),
		gitPull: r["gitPull"] === true,
		commitMessage,
	};
}

export class Store {
	readonly dataDir: string;
	readonly #jobsFile: string;
	readonly #runsDir: string;
	/** Run summaries, read from disk once; /jobs asks for them on every poll. */
	readonly #runs = new Map<string, Run>();

	// No parameter properties: Node's type stripping, which runs this file on
	// the server without a build step, does not support them.
	constructor(dataDir: string) {
		this.dataDir = dataDir;
		this.#jobsFile = path.join(dataDir, "jobs.json");
		this.#runsDir = path.join(dataDir, "runs");
		mkdirSync(this.#runsDir, { recursive: true });
		for (const name of readdirSync(this.#runsDir)) {
			if (!name.endsWith(".json")) continue;
			try {
				const run = JSON.parse(readFileSync(path.join(this.#runsDir, name), "utf8")) as Run;
				if (run?.id) this.#runs.set(run.id, run);
			} catch {
				// a half-written or foreign file: skip it
			}
		}
	}

	#writeJson(file: string, value: unknown): void {
		const temp = `${file}.tmp`;
		writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, file);
	}

	jobs(): Job[] {
		if (!existsSync(this.#jobsFile)) return [];
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.#jobsFile, "utf8"));
			// Jobs saved before there was a choice of engine are Claude jobs.
			return Array.isArray(parsed) ? (parsed as Job[]).map((job) => (job.engine ? job : { ...job, engine: "claude" })) : [];
		} catch {
			return [];
		}
	}

	job(id: string): Job | undefined {
		return this.jobs().find((j) => j.id === id);
	}

	createJob(input: JobInput): Job {
		const now = Date.now();
		const job: Job = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
		this.#writeJson(this.#jobsFile, [...this.jobs(), job]);
		return job;
	}

	updateJob(id: string, input: JobInput): Job | null {
		const jobs = this.jobs();
		const existing = jobs.find((j) => j.id === id);
		if (!existing) return null;
		const job: Job = { ...existing, ...input, id, updatedAt: Date.now() };
		this.#writeJson(this.#jobsFile, jobs.map((j) => (j.id === id ? job : j)));
		return job;
	}

	deleteJob(id: string): boolean {
		const jobs = this.jobs();
		if (!jobs.some((j) => j.id === id)) return false;
		this.#writeJson(this.#jobsFile, jobs.filter((j) => j.id !== id));
		for (const run of this.runs({ jobId: id, limit: 10_000 })) this.#deleteRun(run.id);
		return true;
	}

	#runFile(id: string, ext: "json" | "ndjson"): string {
		if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Bad run id.");
		return path.join(this.#runsDir, `${id}.${ext}`);
	}

	saveRun(run: Run): void {
		this.#writeJson(this.#runFile(run.id, "json"), run);
		this.#runs.set(run.id, run);
	}

	run(id: string): Run | null {
		if (!/^[0-9a-f-]{36}$/.test(id)) return null;
		return this.#runs.get(id) ?? null;
	}

	runs(filter: { readonly jobId?: string; readonly limit?: number } = {}): Run[] {
		const runs = [...this.#runs.values()].filter((run) => !filter.jobId || run.jobId === filter.jobId);
		runs.sort((a, b) => b.startedAt - a.startedAt);
		return runs.slice(0, filter.limit ?? 100);
	}

	appendEvent(runId: string, event: RunEvent): void {
		appendFileSync(this.#runFile(runId, "ndjson"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
	}

	/** Events after `after`, at most a page of them; the app asks again for more. */
	events(runId: string, after = -1, limit = MAX_EVENTS_PER_PAGE): RunEvent[] {
		let raw: string;
		try {
			raw = readFileSync(this.#runFile(runId, "ndjson"), "utf8");
		} catch {
			return [];
		}
		const events: RunEvent[] = [];
		for (const line of raw.split("\n")) {
			if (!line) continue;
			try {
				const event = JSON.parse(line) as RunEvent;
				if (event.seq > after) events.push(event);
				if (events.length >= Math.min(limit, MAX_EVENTS_PER_PAGE)) break;
			} catch {
				// skip a torn last line
			}
		}
		return events;
	}

	/** Keep the newest RUNS_PER_JOB runs of a job. */
	prune(jobId: string): void {
		for (const run of this.runs({ jobId, limit: 10_000 }).slice(RUNS_PER_JOB)) this.#deleteRun(run.id);
	}

	#deleteRun(id: string): void {
		this.#runs.delete(id);
		rmSync(this.#runFile(id, "json"), { force: true });
		rmSync(this.#runFile(id, "ndjson"), { force: true });
	}
}
