import type { Run } from "../../../runner/src/types.ts";
import type { PushService } from "./push.ts";
import type { RunnerClient } from "./runner-client.ts";

const RUNS_PER_LOOK = 50;
const FAILED = new Set<Run["status"]>(["error", "timeout"]);
const BODY_CHARS = 140;

export type RunsWatcherDeps = {
	readonly client: Pick<RunnerClient, "runs">;
	readonly push: Pick<PushService, "notify">;
	readonly intervalMs: number;
	/** Run ids the phone started: their success is pushed too. Shared with the runs route. */
	readonly startedByPhone: Set<string>;
};

const firstLine = (text: string): string => (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, BODY_CHARS);

/**
 * Looks at the runner on a timer and pushes each finished run once: a failure
 * always, a success only when the phone started it. What had already finished
 * when the watcher began is history, not news.
 */
export class RunsWatcher {
	readonly #deps: RunsWatcherDeps;
	readonly #seen = new Set<string>();
	#baselined = false;
	#running = false;
	#timer: NodeJS.Timeout | null = null;

	constructor(deps: RunsWatcherDeps) {
		this.#deps = deps;
	}

	start(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => void this.check(), this.#deps.intervalMs);
		this.#timer.unref();
		void this.check();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
	}

	/** One look; never throws. */
	async check(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			const runs = await this.#deps.client.runs(RUNS_PER_LOOK);
			const finished = runs.filter((r) => r.status !== "running" && !this.#seen.has(r.id));
			for (const run of finished) this.#seen.add(run.id);
			if (!this.#baselined) {
				this.#baselined = true;
				return;
			}
			for (const run of finished) {
				await this.#tell(run);
				this.#deps.startedByPhone.delete(run.id); // handled: the set must not grow forever
			}
		} catch (error) {
			console.error("phone: runs check failed", error);
		} finally {
			this.#running = false;
		}
	}

	async #tell(run: Run): Promise<void> {
		const failed = FAILED.has(run.status);
		if (!failed && !(run.status === "ok" && this.#deps.startedByPhone.has(run.id))) return;
		const body = failed ? firstLine(run.error) || `Ended with ${run.status}.` : firstLine(run.result) || "Done.";
		try {
			await this.#deps.push.notify({ title: `${run.jobName} ${failed ? "failed" : "finished"}`, body, url: `/runs/${run.id}`, tag: `run-${run.id}` });
		} catch (error) {
			console.error("phone: run push failed", error);
		}
	}
}
