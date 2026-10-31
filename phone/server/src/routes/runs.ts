import type { Route } from "../http.ts";
import { RunnerError, type RunnerClient } from "../runner-client.ts";

const NOT_CONNECTED = "Automations are not connected yet.";
const ID = /^[\w-]{1,80}$/;
const RUNS_LIMIT = 50;
/** How long the events proxy waits for a running run to say more. */
const LONG_POLL_TRIES = 8;
const LONG_POLL_STEP_MS = 1000;

export type RunsRouteDeps = {
	/** Null when the runner token or certificate is missing: every runs route then answers 503. */
	readonly client: Pick<RunnerClient, "jobs" | "runs" | "run" | "events" | "runNow" | "cancel"> | null;
	readonly startedByPhone: Set<string>;
	readonly sleep?: (ms: number) => Promise<void>;
};

const nap = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The runner's own "no such item" (404) or "not running" (409) passes through; anything else is a bad gateway. */
function failure(error: unknown): { status: number; body: { error: string } } {
	if (error instanceof RunnerError && (error.status === 404 || error.status === 409)) return { status: error.status, body: { error: error.message } };
	console.error("phone: runner call failed", error);
	return { status: 502, body: { error: "The runner did not answer." } };
}

/** Read the runs, run a job now, cancel a run; there is no way to create, edit or delete a job. */
export function createRunsRoute(deps: RunsRouteDeps): Route {
	const sleep = deps.sleep ?? nap;
	return async (req, url) => {
		const parts = url.pathname.split("/").filter(Boolean);
		const [api, first, id, third] = parts;
		if (api !== "api" || (first !== "runs" && first !== "jobs")) return null;
		const method = req.method ?? "GET";
		const idOk = id !== undefined && ID.test(id);
		const listing = first === "runs" && parts.length === 2 && method === "GET";
		const one = first === "runs" && parts.length === 3 && method === "GET" && idOk;
		const events = first === "runs" && parts.length === 4 && third === "events" && method === "GET" && idOk;
		const cancel = first === "runs" && parts.length === 4 && third === "cancel" && method === "POST" && idOk;
		const runNow = first === "jobs" && parts.length === 4 && third === "run" && method === "POST" && idOk;
		if (!listing && !one && !events && !cancel && !runNow) return { status: 404, body: { error: "not found" } };
		const client = deps.client;
		if (!client) return { status: 503, body: { error: NOT_CONNECTED } };
		try {
			if (listing) {
				const [jobs, runs] = await Promise.all([client.jobs(), client.runs(RUNS_LIMIT)]);
				return { status: 200, body: { jobs, runs } };
			}
			if (one) return { status: 200, body: await client.run(id) };
			if (events) {
				const afterParam = url.searchParams.get("after");
				const afterRaw = afterParam === null || afterParam.trim() === "" ? -1 : Number(afterParam);
				const after = Number.isFinite(afterRaw) ? afterRaw : -1;
				let found = await client.events(id, after);
				for (let tries = 0; found.length === 0 && tries < LONG_POLL_TRIES; tries += 1) {
					if ((await client.run(id)).status !== "running") break;
					await sleep(LONG_POLL_STEP_MS);
					found = await client.events(id, after);
				}
				return { status: 200, body: found };
			}
			if (cancel) {
				await client.cancel(id as string);
				return { status: 200, body: { ok: true } };
			}
			const run = await client.runNow(id as string);
			deps.startedByPhone.add(run.id);
			return { status: 202, body: run };
		} catch (error) {
			return failure(error);
		}
	};
}
