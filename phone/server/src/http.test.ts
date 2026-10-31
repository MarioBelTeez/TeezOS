import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";
import { createPhoneServer, readJsonBody, type Route } from "./http.ts";

let appDir: string;
let server: Server;
let base: string;
const headers = { "tailscale-user-login": "owner@github" };
const CSP = "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** A raw request (fetch cannot set Host or Origin): the status code. */
function raw(method: string, pathName: string, extra: Record<string, string>, body = "{}"): Promise<number> {
	const url = new URL(base);
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: url.hostname, port: url.port, method, path: pathName, headers: { ...headers, "content-length": String(Buffer.byteLength(body)), ...extra } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end(body);
	});
}

async function start(routes: readonly Route[]): Promise<void> {
	const config = { ...loadConfig({ TEEZ_PHONE_LOGIN: "owner@github" }), appDir, port: 0 };
	server = createPhoneServer(config, routes);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

beforeEach(async () => {
	appDir = await mkdtemp(path.join(tmpdir(), "phone-app-"));
	await writeFile(path.join(appDir, "index.html"), "<html>app</html>");
	await writeFile(path.join(appDir, "app.js"), "console.log(1)");
});
afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(appDir, { recursive: true, force: true });
});

describe("phone server", () => {
	it("serves index.html for an unknown non-API path and 404 JSON for an unknown API path", async () => {
		await start([]);
		const page = await fetch(`${base}/some/route`, { headers });
		expect(page.status).toBe(200);
		expect(await page.text()).toBe("<html>app</html>");
		expect(page.headers.get("content-security-policy")).toBe(CSP);
		expect(page.headers.get("x-content-type-options")).toBe("nosniff");
		const api = await fetch(`${base}/api/nope`, { headers });
		expect(api.status).toBe(404);
		expect(api.headers.get("content-type")).toContain("application/json");
		expect(api.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await api.json()).toEqual({ error: "not found" });
	});
	it("lets a stream route set its content-type but never the security headers", async () => {
		await start([
			async (_req, url) =>
				url.pathname === "/api/events"
					? {
							status: 200,
							headers: { "content-type": "text/event-stream", "content-security-policy": "default-src *" },
							stream: async (res) => {
								res.end("data: hi\n\n");
							},
						}
					: url.pathname === "/api/bad"
						? {
								status: 200,
								stream: async () => {
									throw new Error("nope");
								},
							}
						: null,
		]);
		const res = await fetch(`${base}/api/events`, { headers });
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(res.headers.get("content-security-policy")).toBe(CSP);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await res.text()).toBe("data: hi\n\n");
		expect((await fetch(`${base}/api/bad`, { headers })).status).toBe(500);
	});
	it("sends CSP and nosniff on API JSON and on 403", async () => {
		await start([async () => ({ status: 200, body: {} })]);
		for (const res of [await fetch(`${base}/api/x`, { headers }), await fetch(`${base}/api/x`)]) {
			expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		}
	});
	it("refuses a request without the login header, even for static files", async () => {
		await start([]);
		expect((await fetch(`${base}/`)).status).toBe(403);
		expect((await fetch(`${base}/api/x`, { headers: { "tailscale-user-login": "x@github" } })).status).toBe(403);
	});
	it("serves static files with their type and does not escape appDir", async () => {
		await start([]);
		const js = await fetch(`${base}/app.js`, { headers });
		expect(js.headers.get("content-type")).toContain("javascript");
		const escape = await fetch(`${base}/..%2f..%2fetc%2fpasswd`, { headers });
		expect(await escape.text()).toBe("<html>app</html>");
	});
	it("dispatches api routes and returns their JSON", async () => {
		await start([async (_req, url) => (url.pathname === "/api/ping" ? { status: 200, body: { pong: true } } : null)]);
		const res = await fetch(`${base}/api/ping`, { headers });
		expect(await res.json()).toEqual({ pong: true });
	});
	it("answers 500 JSON when a route throws, and 413 when the body is over 1 MB", async () => {
		await start([
			async (req, url) => {
				if (url.pathname === "/api/boom") throw new Error("secret detail");
				if (url.pathname === "/api/body") {
					await readJsonBody(req);
					return { status: 200, body: {} };
				}
				return null;
			},
		]);
		const boom = await fetch(`${base}/api/boom`, { headers });
		expect(boom.status).toBe(500);
		expect(JSON.stringify(await boom.json())).not.toContain("secret");
		const big = await fetch(`${base}/api/body`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ a: "x".repeat(1_100_000) }) });
		expect(big.status).toBe(413);
	});

	describe("cross-site requests", () => {
		const echo: Route = async (req, url) => {
			if (url.pathname !== "/api/echo") return null;
			if (req.method !== "GET") await readJsonBody(req);
			return { status: 200, body: { ok: true } };
		};
		const json = { "content-type": "application/json" };

		it("refuses a write without a JSON content-type (415), parameters allowed", async () => {
			await start([echo]);
			expect(await raw("POST", "/api/echo", { "content-type": "text/plain" })).toBe(415);
			expect(await raw("POST", "/api/echo", {})).toBe(415);
			expect(await raw("DELETE", "/api/echo", { "content-type": "application/x-www-form-urlencoded" })).toBe(415);
			expect(await raw("POST", "/api/echo", { "content-type": "application/json; charset=utf-8" })).toBe(200);
			expect(await raw("POST", "/api/echo", { "content-type": "Application/JSON" })).toBe(200);
		});
		it("refuses a write whose Sec-Fetch-Site is not same-origin or none (403)", async () => {
			await start([echo]);
			expect(await raw("POST", "/api/echo", { ...json, "sec-fetch-site": "cross-site" })).toBe(403);
			expect(await raw("POST", "/api/echo", { ...json, "sec-fetch-site": "same-site" })).toBe(403);
			expect(await raw("POST", "/api/echo", { ...json, "sec-fetch-site": "same-origin" })).toBe(200);
			expect(await raw("POST", "/api/echo", { ...json, "sec-fetch-site": "none" })).toBe(200);
		});
		it("refuses a write from another Origin (403), allows its own host and the forwarded host", async () => {
			await start([echo]);
			const own = new URL(base).host;
			expect(await raw("POST", "/api/echo", { ...json, origin: "https://evil.example" })).toBe(403);
			expect(await raw("POST", "/api/echo", { ...json, origin: "null" })).toBe(403);
			expect(await raw("POST", "/api/echo", { ...json, origin: `http://${own}` })).toBe(200);
			// tailscale serve to a unix socket sends Host: localhost and the real host in X-Forwarded-Host.
			const phone = "teez-phone.example.ts.net";
			expect(await raw("POST", "/api/echo", { ...json, host: "localhost", "x-forwarded-host": phone, origin: `https://${phone}` })).toBe(200);
			expect(await raw("POST", "/api/echo", { ...json, host: "localhost", "x-forwarded-host": phone, origin: "https://evil.example" })).toBe(403);
		});
		it("allows a write with neither Origin nor Sec-Fetch-Site (the iOS Shortcut)", async () => {
			await start([echo]);
			expect(await raw("POST", "/api/echo", json)).toBe(200);
		});
		it("does not check reads", async () => {
			await start([echo]);
			expect(await raw("GET", "/api/echo", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }, "")).toBe(200);
		});
	});
});
