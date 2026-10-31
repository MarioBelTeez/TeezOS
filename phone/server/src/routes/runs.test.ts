import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";
import { createPhoneServer } from "../http.ts";
import { createRunsRoute } from "./runs.ts";

const headers = { "tailscale-user-login": "owner@github", "content-type": "application/json" };
let server: Server | undefined;

function fakeClient() {
	return {
		jobs: vi.fn().mockResolvedValue([{ id: "j1", name: "Nightly" }]),
		runs: vi.fn().mockResolvedValue([{ id: "r1" }]),
		run: vi.fn().mockResolvedValue({ id: "r1", status: "ok" }),
		events: vi.fn().mockResolvedValue([{ seq: 0, at: 1, data: {} }]),
		runNow: vi.fn().mockResolvedValue({ id: "r9" }),
		cancel: vi.fn().mockResolvedValue(undefined),
	};
}

async function start(client: ReturnType<typeof fakeClient> | null, startedByPhone = new Set<string>()): Promise<string> {
	const running = createPhoneServer(loadConfig({ TEEZ_PHONE_LOGIN: "owner@github" }), [createRunsRoute({ client: client as never, startedByPhone, sleep: async () => undefined })]);
	server = running;
	await new Promise<void>((resolve) => running.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(running.address() as AddressInfo).port}`;
}
afterEach(async () => {
	const running = server;
	server = undefined;
	if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
});

describe("runs route", () => {
	it("lists jobs and runs, shows a run and its events", async () => {
		const client = fakeClient();
		const base = await start(client);
		expect(await (await fetch(`${base}/api/runs`, { headers })).json()).toEqual({ jobs: [{ id: "j1", name: "Nightly" }], runs: [{ id: "r1" }] });
		expect(await (await fetch(`${base}/api/runs/r1`, { headers })).json()).toEqual({ id: "r1", status: "ok" });
		expect(await (await fetch(`${base}/api/runs/r1/events?after=4`, { headers })).json()).toEqual([{ seq: 0, at: 1, data: {} }]);
		expect(client.events).toHaveBeenCalledWith("r1", 4);
	});

	it("runs a job now and remembers the phone started it; cancels a run", async () => {
		const client = fakeClient();
		const started = new Set<string>();
		const base = await start(client, started);
		const res = await fetch(`${base}/api/jobs/j1/run`, { method: "POST", headers, body: "{}" });
		expect(res.status).toBe(202);
		expect(client.runNow).toHaveBeenCalledWith("j1");
		expect(started.has("r9")).toBe(true);
		expect((await fetch(`${base}/api/runs/r9/cancel`, { method: "POST", headers, body: "{}" })).status).toBe(200);
		expect(client.cancel).toHaveBeenCalledWith("r9");
	});

	it("has no job edit routes", async () => {
		const client = fakeClient();
		const base = await start(client);
		for (const [method, url] of [["POST", "/api/jobs"], ["PUT", "/api/jobs/j1"], ["DELETE", "/api/jobs/j1"], ["PATCH", "/api/jobs/j1"], ["PUT", "/api/claude-token"]] as const) {
			const res = await fetch(`${base}${url}`, { method, headers, body: "{}" });
			expect(res.status, `${method} ${url}`).toBe(404);
		}
	});

	it("answers 503 when automations are not connected", async () => {
		const base = await start(null);
		const res = await fetch(`${base}/api/runs`, { headers });
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "Automations are not connected yet." });
	});

	it("rejects odd ids", async () => {
		const base = await start(fakeClient());
		expect((await fetch(`${base}/api/runs/..%2Fx`, { headers })).status).toBe(404);
	});
});

describe("runs route events cursor", () => {
	it("treats an empty after as missing so event 0 is not skipped", async () => {
		const client = fakeClient();
		const base = await start(client);
		await fetch(`${base}/api/runs/r1/events?after=`, { headers });
		expect(client.events).toHaveBeenCalledWith("r1", -1);
	});
});
