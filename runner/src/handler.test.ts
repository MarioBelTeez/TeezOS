import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandler, send } from "./handler.ts";

const MAIN = "m".repeat(40);
const PHONE = "p".repeat(40);
let server: Server | undefined;

async function start() {
	const seen: string[] = [];
	const routes = vi.fn(async (req, res, url: URL) => {
		seen.push(`${req.method} ${url.pathname}`);
		send(res, 200, { ok: true });
	});
	const running = createServer(createHandler({ tokens: { main: MAIN, phone: PHONE }, routes }));
	server = running;
	await new Promise<void>((resolve) => running.listen(0, "127.0.0.1", resolve));
	const port = (running.address() as AddressInfo).port;
	return { port, seen, call: (method: string, path: string, token?: string) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }) };
}
afterEach(async () => {
	const running = server;
	server = undefined;
	if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
});

function raw(port: number, bytes: string): Promise<string> {
	return new Promise((resolve) => {
		let out = "";
		const socket = connect(port, "127.0.0.1", () => socket.write(bytes));
		socket.on("data", (d) => (out += d.toString()));
		socket.on("close", () => resolve(out));
		socket.on("error", () => resolve(out));
	});
}

describe("runner request handler", () => {
	it("answers 400 to a malformed absolute-form target and keeps serving", async () => {
		const { port, call, seen } = await start();
		expect(await raw(port, "GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")).toMatch(/^HTTP\/1\.1 400/);
		expect((await call("GET", "/health", MAIN)).status).toBe(200);
		expect(seen).toEqual(["GET /health"]);
	});

	it("401 without a token or with a wrong one", async () => {
		const { call, seen } = await start();
		expect((await call("GET", "/runs")).status).toBe(401);
		expect((await call("GET", "/runs", "x".repeat(40))).status).toBe(401);
		expect(seen).toEqual([]);
	});

	it("403 for the phone token on job edits and the Claude token, including a dot-segment trick", async () => {
		const { call, seen } = await start();
		expect((await call("PUT", "/jobs/x", PHONE)).status).toBe(403);
		expect((await call("PUT", "/claude-token", PHONE)).status).toBe(403);
		expect((await call("GET", "/claude-token", PHONE)).status).toBe(403);
		expect((await call("PUT", "/jobs/%2e%2e/claude-token", PHONE)).status).toBe(403);
		expect(seen).toEqual([]);
	});

	it("passes allowed phone requests to the routes", async () => {
		const { call, seen } = await start();
		expect((await call("GET", "/runs", PHONE)).status).toBe(200);
		expect((await call("GET", "/health/", PHONE)).status).toBe(200);
		expect(seen).toEqual(["GET /runs", "GET /health/"]);
	});

	it("keeps the main token's full access", async () => {
		const { call, seen } = await start();
		expect((await call("POST", "/jobs", MAIN)).status).toBe(200);
		expect((await call("PUT", "/claude-token", MAIN)).status).toBe(200);
		expect(seen).toEqual(["POST /jobs", "PUT /claude-token"]);
	});
});
