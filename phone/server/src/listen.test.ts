import { createServer, request, type Server } from "node:http";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenPhone, shutdownPhone } from "./listen.ts";

let dir: string;
let server: Server;
beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "phone-listen-"));
	server = createServer((_req, res) => res.end("ok"));
});
afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(dir, { recursive: true, force: true });
});

const getOverSocket = (socketPath: string): Promise<string> =>
	new Promise((resolve, reject) => {
		const req = request({ socketPath, path: "/" }, (res) => {
			let body = "";
			res.on("data", (chunk) => (body += String(chunk)));
			res.on("end", () => resolve(body));
		});
		req.on("error", reject);
		req.end();
	});

describe("listenPhone", () => {
	it("listens on loopback TCP when no socket is configured (tests and dev)", async () => {
		const where = await listenPhone(server, { socket: "", host: "127.0.0.1", port: 0 });
		expect(where).toMatch(/^127\.0\.0\.1:\d+$/);
	});

	// Node has no AF_UNIX listener on Windows (a path there is a named pipe).
	it.skipIf(process.platform === "win32")("listens on the socket, owner-only, replacing a stale socket", async () => {
		const socket = path.join(dir, "phone.sock");
		// A socket left by a previous run that was killed.
		const stale = createServer();
		await new Promise<void>((resolve) => stale.listen(socket, resolve));
		await new Promise<void>((resolve) => {
			stale.close(() => resolve());
		});
		await writeFile(path.join(dir, "keep"), "");
		const where = await listenPhone(server, { socket, host: "127.0.0.1", port: 0 });
		expect(where).toBe(socket);
		expect((await stat(socket)).mode & 0o777).toBe(0o600);
		expect(await getOverSocket(socket)).toBe("ok");
	});

	it.skipIf(process.platform === "win32")("refuses to remove something at the socket path that is not a socket", async () => {
		const socket = path.join(dir, "phone.sock");
		await writeFile(socket, "not a socket");
		await expect(listenPhone(server, { socket, host: "127.0.0.1", port: 0 })).rejects.toThrow(/not a socket/);
	});
});

describe("shutdownPhone", () => {
	it("closes open event streams, stops the timers and exits 0 once local work is done", async () => {
		const sse = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(": connected\n\n");
		});
		const where = await listenPhone(sse, { socket: "", host: "127.0.0.1", port: 0 });
		const [host, port] = where.split(":");
		await new Promise<void>((resolve) => {
			request({ host, port: Number(port), path: "/" }, (res) => {
				res.once("data", () => resolve());
				res.on("error", () => undefined);
			})
				.on("error", () => undefined)
				.end();
		});
		const stop = vi.fn();
		const exited = new Promise<number>((resolve) => shutdownPhone(sse, { stop, idle: async () => undefined, exit: resolve, forceMs: 5000 }));
		expect(await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("hung"), 2000))])).toBe(0);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("forces exit 1 when local work does not finish in time", async () => {
		const idleServer = createServer();
		await listenPhone(idleServer, { socket: "", host: "127.0.0.1", port: 0 });
		const exited = new Promise<number>((resolve) => shutdownPhone(idleServer, { stop: () => undefined, idle: () => new Promise(() => undefined), exit: resolve, forceMs: 100 }));
		expect(await exited).toBe(1);
	});
});
