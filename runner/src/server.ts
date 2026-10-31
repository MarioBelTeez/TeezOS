import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { hostname } from "node:os";
import path from "node:path";
import { createHandler, send } from "./handler.ts";
import { nextRun, parseCron } from "./cron.ts";
import { keepKnownPath, probeAgy, type AgyStatus, type RunAsJobUser } from "./agy.ts";
import { Executor, asJobUser } from "./executor.ts";
import { Store, validateJob } from "./store.ts";
import type { Health, Job } from "./types.ts";

/**
 * teez-runner: scheduled Claude Code and Antigravity jobs on the always-on server, driven by
 * the TeezAI app over HTTPS with a bearer token.
 *
 * Configuration comes from the environment (see deploy/teez-runner.service):
 * the data and work directories, the port, the TLS pair, and the file that
 * holds the API token.
 */

export const VERSION = "0.3.0";

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

export function startServer(): void {
	const dataDir = env("TEEZ_RUNNER_DATA", "/var/lib/teez-runner");
	const workDir = env("TEEZ_RUNNER_WORK", "/home/agent/work");
	const port = Number(env("TEEZ_RUNNER_PORT", "7420"));
	const apiToken = readFileSync(env("TEEZ_RUNNER_TOKEN_FILE", "/etc/teez-runner/token"), "utf8").trim();
	if (apiToken.length < 32) throw new Error("The API token is missing or too short.");
	const phoneTokenFile = process.env["TEEZ_RUNNER_PHONE_TOKEN_FILE"];
	// Optional: without the file, only the main token works.
	const phoneToken = phoneTokenFile && existsSync(phoneTokenFile) ? readFileSync(phoneTokenFile, "utf8").trim() : null;
	if (phoneToken !== null && phoneToken.length < 32) throw new Error("The phone token is too short.");
	if (phoneTokenFile && phoneToken === null) console.log(`phone token file ${phoneTokenFile} is missing: only the main token works`);
	const claudeTokenFile = path.join(dataDir, "claude-token");

	const claudePath = (() => {
		if (process.env["TEEZ_RUNNER_CLAUDE"]) return process.env["TEEZ_RUNNER_CLAUDE"];
		try {
			return execFileSync("sh", ["-lc", "command -v claude"], { encoding: "utf8" }).trim() || "claude";
		} catch {
			return "claude";
		}
	})();
	// `claude --version` takes a second or two; /health is polled every few
	// seconds, so the answer is refreshed in the background, never inline.
	let claudeVersionCache = "";
	const refreshClaudeVersion = (): void => {
		const jobUser = process.env["TEEZ_RUNNER_JOB_USER"];
		const [file, args] = jobUser ? ["sudo", ["-n", "-H", "-u", jobUser, "--", claudePath, "--version"]] : [claudePath, ["--version"]];
		execFile(file as string, args as string[], { encoding: "utf8", timeout: 30_000 }, (error, stdout) => {
			claudeVersionCache = error ? "" : stdout.trim();
		});
	};
	refreshClaudeVersion();
	setInterval(refreshClaudeVersion, 10 * 60_000).unref();
	const claudeVersion = (): string => claudeVersionCache;

	const store = new Store(dataDir);
	// Runs that were "running" when the runner last stopped can never finish now.
	for (const run of store.runs({ limit: 10_000 })) {
		if (run.status === "running") store.saveRun({ ...run, status: "error", endedAt: Date.now(), error: "The runner restarted during this run." });
	}
	const jobUser = process.env["TEEZ_RUNNER_JOB_USER"] || undefined;

	// Antigravity, as the job user, also refreshed in the background.
	let agy: AgyStatus = { path: null, installed: false, version: "", loggedIn: false, models: [] };
	const runAsJobUser: RunAsJobUser = (file, args) =>
		new Promise((resolve) => {
			const command = asJobUser(jobUser, "/", file, args);
			execFile(command.file, command.args, { cwd: command.cwd, encoding: "utf8", timeout: 60_000 }, (error, stdout) => resolve({ ok: !error, stdout }));
		});
	const refreshAgy = (): void => {
		void probeAgy(runAsJobUser, process.env["TEEZ_RUNNER_AGY"]).then((status) => {
			const next = keepKnownPath(agy, status);
			if (next.installed !== agy.installed || next.loggedIn !== agy.loggedIn || next.version !== agy.version) {
				console.log(`antigravity: ${next.installed ? `agy ${next.version}, ${next.loggedIn ? `logged in, ${next.models.length} models` : "not logged in"}` : "not installed"}`);
			}
			agy = next;
		});
	};
	refreshAgy();
	setInterval(refreshAgy, 10 * 60_000).unref();

	const executor = new Executor({
		store,
		claudePath,
		...(jobUser ? { jobUser } : {}),
		claudeToken: () => (existsSync(claudeTokenFile) ? readFileSync(claudeTokenFile, "utf8").trim() || null : null),
		agyPath: () => agy.path,
	});

	// ---- scheduler: missed runs while the runner was down are skipped, not replayed.
	// `null` means "planned, never runs" (disabled, manual, or an impossible
	// date), so such jobs are not re-planned on every tick.
	const next = new Map<string, number | null>();
	const plannedFor = new Map<string, number>();
	const plan = (job: Job, from: Date): void => {
		plannedFor.set(job.id, job.updatedAt);
		if (!job.enabled || !job.schedule) {
			next.set(job.id, null);
			return;
		}
		try {
			next.set(job.id, nextRun(parseCron(job.schedule), from)?.getTime() ?? null);
		} catch {
			next.set(job.id, null);
		}
	};
	for (const job of store.jobs()) plan(job, new Date());
	setInterval(() => {
		const now = Date.now();
		for (const job of store.jobs()) {
			if (plannedFor.get(job.id) !== job.updatedAt) plan(job, new Date());
			const due = next.get(job.id);
			if (due === null || due === undefined || due > now) continue;
			if (executor.isRunning(job.id)) {
				plan(job, new Date(now)); // still busy with the last one: skip this occurrence
				continue;
			}
			try {
				executor.start(job, "schedule");
				plan(job, new Date(now));
			} catch (error) {
				// At capacity: leave it due, so the next tick tries again.
				console.error(`schedule ${job.name}: ${String(error)}`);
			}
		}
	}, 15_000).unref();

	const withNext = (job: Job): Job & { nextRun: number | null; lastRun: unknown } => ({
		// (nextRun is null for manual-only and impossible schedules)
		...job,
		nextRun: next.get(job.id) ?? null,
		lastRun: store.runs({ jobId: job.id, limit: 1 })[0] ?? null,
	});

	const folders = (): string[] => {
		try {
			return readdirSync(workDir)
				.map((name) => path.posix.join(workDir, name))
				.filter((full) => statSync(full).isDirectory());
		} catch {
			return [];
		}
	};

	const readBody = (req: IncomingMessage): Promise<unknown> =>
		new Promise((resolve, reject) => {
			let size = 0;
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > 64 * 1024) {
					reject(new Error("Request too large."));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => {
				if (chunks.length === 0) return resolve({});
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch {
					reject(new Error("The body is not JSON."));
				}
			});
			req.on("error", reject);
		});

	const routes = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
		const parts = url.pathname.split("/").filter(Boolean);
		const method = req.method ?? "GET";

		if (method === "GET" && url.pathname === "/health") {
			const health: Health = {
				ok: true,
				version: VERSION,
				hostname: hostname(),
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				claude: { installed: claudePath !== "claude" || !!claudeVersion(), version: claudeVersion(), hasToken: existsSync(claudeTokenFile) },
				antigravity: { installed: agy.installed, version: agy.version, loggedIn: agy.loggedIn, models: agy.models },
				workDir,
				folders: folders(),
				running: executor.running,
			};
			return send(res, 200, health);
		}

		if (parts[0] === "jobs") {
			if (method === "GET" && parts.length === 1) return send(res, 200, store.jobs().map(withNext));
			if (method === "POST" && parts.length === 1) {
				const job = store.createJob(validateJob(await readBody(req), workDir));
				plan(job, new Date());
				return send(res, 201, withNext(job));
			}
			const id = parts[1] ?? "";
			if (method === "PUT" && parts.length === 2) {
				const job = store.updateJob(id, validateJob(await readBody(req), workDir, store.job(id)));
				if (!job) return send(res, 404, { error: "No such job." });
				plan(job, new Date());
				return send(res, 200, withNext(job));
			}
			if (method === "DELETE" && parts.length === 2) {
				next.delete(id);
				return send(res, store.deleteJob(id) ? 200 : 404, { ok: true });
			}
			if (method === "POST" && parts[2] === "run") {
				const job = store.job(id);
				if (!job) return send(res, 404, { error: "No such job." });
				return send(res, 202, executor.start(job, "manual"));
			}
		}

		if (parts[0] === "runs") {
			if (method === "GET" && parts.length === 1) {
				const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50);
				const jobId = url.searchParams.get("job") ?? undefined;
				return send(res, 200, store.runs({ ...(jobId ? { jobId } : {}), limit }));
			}
			const id = parts[1] ?? "";
			if (method === "GET" && parts.length === 2) {
				const run = store.run(id);
				return run ? send(res, 200, run) : send(res, 404, { error: "No such run." });
			}
			if (method === "GET" && parts[2] === "events") {
				const after = Number(url.searchParams.get("after") ?? -1);
				const limit = Number(url.searchParams.get("limit") ?? 2000);
				return send(res, 200, store.events(id, Number.isFinite(after) ? after : -1, Number.isFinite(limit) ? limit : 2000));
			}
			if (method === "POST" && parts[2] === "cancel") return send(res, executor.cancel(id) ? 200 : 404, { ok: true });
		}

		if (url.pathname === "/claude-token") {
			if (method === "PUT") {
				const body = (await readBody(req)) as { token?: unknown };
				const token = typeof body.token === "string" ? body.token.trim() : "";
				if (!/^sk-ant-[\w-]{20,}$/.test(token)) return send(res, 400, { error: "That does not look like a Claude token (sk-ant-…)." });
				writeFileSync(claudeTokenFile, `${token}\n`, { mode: 0o600 });
				return send(res, 200, { ok: true });
			}
			if (method === "DELETE") {
				rmSync(claudeTokenFile, { force: true });
				return send(res, 200, { ok: true });
			}
		}

		send(res, 404, { error: "Not found." });
	};

	const server = createServer(
		{
			cert: readFileSync(env("TEEZ_RUNNER_TLS_CERT", "/etc/teez-runner/tls.crt")),
			key: readFileSync(env("TEEZ_RUNNER_TLS_KEY", "/etc/teez-runner/tls.key")),
		},
		createHandler({ tokens: { main: apiToken, phone: phoneToken }, routes }),
	);
	const bind = env("TEEZ_RUNNER_BIND", "0.0.0.0");
	server.listen(port, bind, () => console.log(`teez-runner ${VERSION} on ${bind}:${port}, work ${workDir}, jobs as ${jobUser ?? "this user"}, claude ${claudePath}`));

	const stop = (): void => {
		executor.cancelAll();
		server.close();
		setTimeout(() => process.exit(0), 3000).unref();
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
