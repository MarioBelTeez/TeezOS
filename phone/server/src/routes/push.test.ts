import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";
import { createPhoneServer } from "../http.ts";
import { createPushRoute } from "./push.ts";

const headers = { "tailscale-user-login": "owner@github", "content-type": "application/json" };
let server: Server | undefined;

async function start(push: unknown, publicKey = "PUB"): Promise<string> {
	const running = createPhoneServer(loadConfig({ TEEZ_PHONE_LOGIN: "owner@github" }), [createPushRoute({ push: push as never, publicKey })]);
	server = running;
	await new Promise<void>((resolve) => running.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(running.address() as AddressInfo).port}`;
}
afterEach(async () => {
	const running = server;
	server = undefined;
	if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
});

const good = { endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } };

describe("push route", () => {
	it("gives the public key, stores and removes subscriptions", async () => {
		const push = { subscribe: vi.fn(), unsubscribe: vi.fn() };
		const base = await start(push);
		expect(await (await fetch(`${base}/api/push/key`, { headers })).json()).toEqual({ publicKey: "PUB" });
		expect((await fetch(`${base}/api/push/subscribe`, { method: "POST", headers, body: JSON.stringify(good) })).status).toBe(200);
		expect(push.subscribe).toHaveBeenCalledWith(good);
		expect((await fetch(`${base}/api/push/subscribe`, { method: "DELETE", headers, body: JSON.stringify({ endpoint: good.endpoint }) })).status).toBe(200);
		expect(push.unsubscribe).toHaveBeenCalledWith(good.endpoint);
	});

	it("rejects malformed subscriptions", async () => {
		const push = { subscribe: vi.fn(), unsubscribe: vi.fn() };
		const base = await start(push);
		for (const body of [{}, { endpoint: "http://insecure/x", keys: good.keys }, { endpoint: good.endpoint, keys: {} }, { endpoint: good.endpoint }]) {
			expect((await fetch(`${base}/api/push/subscribe`, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
		}
		expect((await fetch(`${base}/api/push/subscribe`, { method: "DELETE", headers, body: "{}" })).status).toBe(400);
		expect(push.subscribe).not.toHaveBeenCalled();
	});

	it("answers 503 without VAPID keys", async () => {
		const base = await start(null);
		const calls = [
			["GET", "/api/push/key"],
			["POST", "/api/push/subscribe"],
			["DELETE", "/api/push/subscribe"],
		] as const;
		for (const [method, url] of calls) {
			const res = await fetch(`${base}${url}`, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) });
			expect(res.status).toBe(503);
		}
	});
});
