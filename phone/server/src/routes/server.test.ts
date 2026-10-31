import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";
import { createPhoneServer } from "../http.ts";
import { createServerRoute } from "./server.ts";

const headers = { "tailscale-user-login": "owner@github", "content-type": "application/json" };
let server: Server | undefined;

async function start(deps: Parameters<typeof createServerRoute>[0]): Promise<string> {
	const running = createPhoneServer(loadConfig({ TEEZ_PHONE_LOGIN: "owner@github" }), [createServerRoute(deps)]);
	server = running;
	await new Promise<void>((resolve) => running.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(running.address() as AddressInfo).port}`;
}
afterEach(async () => {
	const running = server;
	server = undefined;
	if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
});

const snapshot = { at: 1, reachable: true, ups: null, guests: [], zfs: [], disks: [], tasks: [] };
const overview = { node: "pve", fetchedAt: 2 };

describe("server route", () => {
	it("returns the snapshot read-only and has no POST routes", async () => {
		const base = await start({ api: () => ({}) as never, look: (async () => snapshot) as never, overview: (async () => overview) as never });
		const got = await fetch(`${base}/api/server`, { headers });
		expect(got.status).toBe(200);
		expect(await got.json()).toEqual({ snapshot, overview });
		for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
			const res = await fetch(`${base}/api/server`, { method, headers, body: "{}" });
			expect(res.status).toBe(405);
		}
		expect((await fetch(`${base}/api/server/guests/100/stop`, { method: "POST", headers, body: "{}" })).status).toBe(404);
	});

	it("answers 503 when monitoring is not set up", async () => {
		const base = await start({ api: () => null, look: vi.fn() as never, overview: vi.fn() as never });
		const res = await fetch(`${base}/api/server`, { headers });
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "Server monitoring is not set up yet." });
	});

	it("answers 502 without leaking the error when Proxmox fails", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const base = await start({ api: () => ({}) as never, look: (async () => Promise.reject(new Error("secret detail"))) as never, overview: vi.fn() as never });
		const res = await fetch(`${base}/api/server`, { headers });
		expect(res.status).toBe(502);
		expect(JSON.stringify(await res.json())).not.toContain("secret detail");
		spy.mockRestore();
	});
});
