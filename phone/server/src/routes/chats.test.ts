import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { get, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ChatService } from "../chat/chat-service.ts";
import { ChatStore } from "../chat/chat-store.ts";
import type { ChildLike, Spawn } from "../chat/job-user.ts";
import { loadConfig } from "../config.ts";
import { createPhoneServer } from "../http.ts";
import { GitSync, type GitRunner } from "../git-sync.ts";
import { createCaptures } from "./captures.ts";
import { createChatsRoute } from "./chats.ts";

const AGY = "/opt/agy";
const headers = { "tailscale-user-login": "owner@github", "content-type": "application/json" };
let dir: string;
let server: Server;
let base: string;
let claudeEnabled = false;
let saveCapture: Mock<(text: string, links: readonly string[]) => Promise<{ path: string; synced: boolean }>>;
let service: ChatService;

function child(reply: string | null): ChildLike {
	const stdout = new PassThrough();
	const stdin = new PassThrough();
	const emitter = new EventEmitter();
	const finish = (out: string): void => {
		stdout.end(out);
		setTimeout(() => emitter.emit("close", 0), 1);
	};
	stdin.on("finish", () => finish(reply ?? ""));
	stdin.resume();
	return { stdin, stdout, stderr: new PassThrough(), on: (e: string, l: never) => emitter.on(e, l), kill: () => finish("") } as never;
}

const reply = [
	{ event: "init", conversation_id: "conv-1", init: {} },
	{ event: "step_update", step_update: { conversation_id: "conv-1", step_type: "agent_response", text_delta: "Hello there" } },
	{ event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: "Hello there" } },
]
	.map((l) => JSON.stringify(l))
	.join("\n");

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "phone-chats-route-"));
	claudeEnabled = false;
	saveCapture = vi.fn(async () => ({ path: "thinking/phone-saved.md", synced: true }));
	const spawn: Spawn = (_file, args) => child(args.includes(AGY) ? reply : "");
	service = new ChatService({
		store: new ChatStore(dir),
		saveCapture,
		spawn,
		jobUser: "phoneagent",
		agentVaultDir: "/vault",
		agyPath: () => AGY,
		claudePath: "claude",
		claudeToken: () => null,
	});
	const route = createChatsRoute({ service, saveCapture, claudeEnabled: () => claudeEnabled, heartbeatMs: 20 });
	server = createPhoneServer({ ...loadConfig({ TEEZ_PHONE_LOGIN: "owner@github" }), appDir: dir, port: 0 }, [route]);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(dir, { recursive: true, force: true });
});

const post = (p: string, body: unknown): Promise<Response> => fetch(`${base}${p}`, { method: "POST", headers, body: JSON.stringify(body) });
const getJson = async (p: string): Promise<{ status: number; body: unknown }> => {
	const res = await fetch(`${base}${p}`, { headers });
	return { status: res.status, body: await res.json() };
};

describe("chats routes", () => {
	it("refuses the claude engine without a token", async () => {
		const res = await post("/api/chats", { engine: "claude" });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "Claude needs a token on the server (claude setup-token)." });
		claudeEnabled = true;
		expect((await post("/api/chats", { engine: "claude", effort: "max" })).status).toBe(201);
	});

	it("creates, lists and reads chats; validates engine, effort and ids", async () => {
		const created = await post("/api/chats", {});
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		const list = await getJson("/api/chats");
		expect(list.body).toEqual([expect.objectContaining({ id, engine: "agy" })]);
		const one = await getJson(`/api/chats/${id}`);
		expect(one.body).toMatchObject({ id, engine: "agy", effort: "medium", cards: [], running: false });

		expect((await post("/api/chats", { engine: "gpt" })).status).toBe(400);
		expect((await post("/api/chats", { effort: "max" })).status).toBe(400);
		expect((await getJson("/api/chats/not-a-uuid")).status).toBe(404);
		expect((await getJson("/api/chats/..%2Fcaptures")).status).toBe(404);
		expect((await getJson("/api/chats/11111111-1111-4111-8111-111111111111")).status).toBe(404);
		expect((await post(`/api/chats/${id}/messages`, { text: "" })).status).toBe(400);
		expect((await post(`/api/chats/${id}/messages`, { text: "x".repeat(20_001) })).status).toBe(400);
	});

	it("saves a 'save this' capture into the chat", async () => {
		const { id } = (await (await post("/api/chats", {})).json()) as { id: string };
		const res = await post(`/api/chats/${id}/save`, { text: "keep this" });
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ path: "thinking/phone-saved.md", synced: true });
		expect(saveCapture).toHaveBeenCalledWith("keep this", []);
		expect((await post(`/api/chats/${id}/save`, { text: " " })).status).toBe(400);
	});

	it("answers 'save this' quickly with synced false while the push hangs, the note committed locally", async () => {
		const vault = path.join(dir, "vault");
		await mkdir(vault, { recursive: true });
		const calls: string[][] = [];
		const git: GitRunner = async (args) => {
			calls.push([...args]);
			if (args[0] === "push") await new Promise(() => undefined);
			if (args[0] === "diff") return { ok: false, output: "" };
			return { ok: true, output: args[0] === "rev-list" ? "1" : "" };
		};
		const captures = createCaptures({ vault, dataDir: path.join(dir, "data"), sync: new GitSync({ vault, git }), now: Date.now });
		const route = createChatsRoute({ service, saveCapture: captures.saveCapture, claudeEnabled: () => false });
		const own = createPhoneServer({ ...loadConfig({ TEEZ_PHONE_LOGIN: "owner@github" }), appDir: dir, port: 0 }, [route]);
		await new Promise<void>((resolve) => own.listen(0, "127.0.0.1", resolve));
		try {
			const ownBase = `http://127.0.0.1:${(own.address() as { port: number }).port}`;
			const send = (p: string, body: unknown) => fetch(`${ownBase}${p}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
			const { id } = (await (await send("/api/chats", {})).json()) as { id: string };
			const res = await send(`/api/chats/${id}/save`, { text: "keep this while GitHub is down" });
			expect(res.status).toBe(201);
			expect(await res.json()).toMatchObject({ synced: false });
			expect(calls.some((c) => c[0] === "commit")).toBe(true);
		} finally {
			own.closeAllConnections();
			await new Promise((resolve) => own.close(resolve));
		}
	});

	it("streams events over SSE", async () => {
		const { id } = (await (await post("/api/chats", {})).json()) as { id: string };
		let received = "";
		let contentType = "";
		let sseHeaders: Record<string, unknown> = {};
		await new Promise<void>((resolve) => {
			get(`${base}/api/chats/${id}/events`, { headers }, (res) => {
				contentType = String(res.headers["content-type"]);
				sseHeaders = res.headers;
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					received += chunk;
					if (received.includes("turn-end") && received.includes(": ping")) {
						res.destroy();
						resolve();
					}
				});
			});
			setTimeout(() => void post(`/api/chats/${id}/messages`, { text: "hi" }).then((r) => expect(r.status).toBe(202)), 30);
		});
		expect(contentType).toBe("text/event-stream");
		expect(sseHeaders).toMatchObject({ "cache-control": "no-cache", "x-accel-buffering": "no" });
		const events = received
			.split("\n\n")
			.filter((block) => block.startsWith("data: "))
			.map((block) => JSON.parse(block.slice(6)) as { kind: string; text?: string });
		expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["session-ready", "text-delta", "turn-end"]));
		expect(events.find((e) => e.kind === "text-delta")?.text).toBe("Hello there");
		await vi.waitFor(async () => expect((await getJson(`/api/chats/${id}`)).body).toMatchObject({ running: false }));

		expect((await post(`/api/chats/${id}/stop`, {})).status).toBe(200);
	});
});
