import { BrowserWindow, Notification, dialog, ipcMain } from "electron";
import type { SettingsStore } from "../settings/store.ts";
import type { SecretStore } from "../settings/secrets.ts";
import { RunnerClient, connectViaSsh } from "../runner/client.ts";
import { runItems, type RunItem } from "../runner/run-items.ts";
import type { Health, Job, Run, RunEvent } from "../../../runner/src/types.ts";

/**
 * Automations over IPC: the runner's jobs and runs, Claude login on the
 * runner, and a desktop notification whenever a run finishes.
 */

export type JobView = Job & { readonly nextRun: number | null; readonly lastRun: Run | null };
export type { RunItem };

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const POLL_MS = 90_000;

export function registerAutomationsIpc(store: SettingsStore, secrets: SecretStore, getWindow: () => BrowserWindow | null): () => void {
	let client: RunnerClient | null = null;
	const getClient = (): RunnerClient | null => {
		if (client) return client;
		const config = store.get().runner;
		const token = secrets.get("runner");
		if (!config?.fingerprint || !config.ca || !token) return null;
		client = new RunnerClient({ baseUrl: config.baseUrl, fingerprint: config.fingerprint, ca: config.ca, vmid: config.vmid ?? 104 }, token);
		return client;
	};
	const reset = (): void => {
		client?.dispose();
		client = null;
	};
	const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
	const call = async <T>(fn: (api: RunnerClient) => Promise<T>): Promise<Result<T>> => {
		const api = getClient();
		if (!api) return { ok: false, reason: "not-configured" };
		try {
			return { ok: true, value: await fn(api) };
		} catch (error) {
			return { ok: false, reason: message(error) };
		}
	};
	const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);

	ipcMain.handle("auto:status", () => {
		const runner = store.get().runner;
		return { configured: !!runner?.fingerprint && secrets.has("runner"), baseUrl: runner?.baseUrl ?? null };
	});

	ipcMain.handle("auto:connect", async (_event, alias: unknown, vmid: unknown): Promise<Result<string>> => {
		try {
			const { config, token } = await connectViaSsh(typeof alias === "string" ? alias : "pve", typeof vmid === "number" ? vmid : 104);
			secrets.set("runner", token);
			store.update((s) => ({ ...s, runner: config }));
			reset();
			return { ok: true, value: config.baseUrl };
		} catch (error) {
			return { ok: false, reason: message(error) };
		}
	});

	ipcMain.handle("auto:disconnect", () => {
		secrets.delete("runner");
		store.update((s) => ({ ...s, runner: null }));
		reset();
	});

	ipcMain.handle("auto:health", () => call((api) => api.request<Health>("GET", "/health")));
	ipcMain.handle("auto:jobs", () => call((api) => api.request<JobView[]>("GET", "/jobs")));
	ipcMain.handle("auto:save-job", (_event, id: unknown, job: unknown) =>
		call((api) => (isId(id) ? api.request<JobView>("PUT", `/jobs/${id}`, job) : api.request<JobView>("POST", "/jobs", job))),
	);
	ipcMain.handle("auto:delete-job", async (_event, id: unknown, name: unknown) => {
		if (!isId(id)) return { ok: false, reason: "Bad id." };
		const window = getWindow();
		const options = { type: "warning" as const, buttons: ["Delete", "Cancel"], defaultId: 1, cancelId: 1, title: "Automations", message: `Delete the job "${String(name)}"?`, detail: "Its run history goes with it." };
		const answer = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
		if (answer.response !== 0) return { ok: false, reason: "cancelled" };
		return call((api) => api.request("DELETE", `/jobs/${id}`));
	});
	ipcMain.handle("auto:run-job", (_event, id: unknown) => (isId(id) ? call((api) => api.request<Run>("POST", `/jobs/${id}/run`)) : { ok: false, reason: "Bad id." }));
	ipcMain.handle("auto:runs", (_event, jobId: unknown) =>
		call((api) => api.request<Run[]>("GET", `/runs?limit=30${isId(jobId) ? `&job=${jobId}` : ""}`)),
	);
	ipcMain.handle("auto:run", (_event, runId: unknown) =>
		isId(runId)
			? call(async (api) => {
					const run = await api.request<Run>("GET", `/runs/${runId}`);
					const [events, jobs] = await Promise.all([api.request<RunEvent[]>("GET", `/runs/${runId}/events`), api.request<JobView[]>("GET", "/jobs")]);
					const job = jobs.find((j) => j.id === run.jobId) ?? null;
					return { run, items: runItems(job, events) };
				})
			: { ok: false, reason: "Bad id." },
	);
	ipcMain.handle("auto:cancel-run", (_event, runId: unknown) => (isId(runId) ? call((api) => api.request("POST", `/runs/${runId}/cancel`)) : { ok: false, reason: "Bad id." }));
	ipcMain.handle("auto:set-claude-token", (_event, token: unknown) =>
		typeof token === "string" ? call((api) => api.request("PUT", "/claude-token", { token })) : { ok: false, reason: "Bad token." },
	);

	// ---- desktop notifications for finished runs
	const seen = new Set<string>();
	let primed = false;
	const poll = async (): Promise<void> => {
		const api = getClient();
		if (!api) return;
		let runs: Run[];
		try {
			runs = await api.request<Run[]>("GET", "/runs?limit=20");
		} catch {
			return;
		}
		for (const run of runs) {
			if (run.status === "running" || seen.has(run.id)) continue;
			seen.add(run.id);
			if (!primed || !Notification.isSupported()) continue;
			const first = (run.result || run.error || "").split("\n").find((l) => l.trim()) ?? "";
			const note = new Notification({
				title: `${run.status === "ok" ? "✓" : "✗"} ${run.jobName}`,
				body: `${run.status}${run.git ? ` · ${run.git}` : ""}${first ? `\n${first.slice(0, 160)}` : ""}`,
			});
			note.on("click", () => {
				const window = getWindow();
				if (!window) return;
				if (window.isMinimized()) window.restore();
				window.focus();
				window.webContents.send("auto:open-run", run.id);
			});
			note.show();
		}
		primed = true;
	};
	const timer = setInterval(() => void poll(), POLL_MS);
	void poll();

	return () => {
		clearInterval(timer);
		reset();
	};
}
