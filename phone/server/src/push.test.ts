import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushService, type PushSubscriptionJSON } from "./push.ts";

let dir: string;
let file: string;
const VAPID = { publicKey: "pub", privateKey: "priv", subject: "https://teez-phone.example.ts.net" };
const PAYLOAD = { title: "T", body: "B", url: "/chat/1", tag: "chat-1" };

const sub = (name: string): PushSubscriptionJSON => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: `p-${name}`, auth: `a-${name}` } });
const service = (send: unknown = vi.fn()): PushService => new PushService({ file, vapid: VAPID, send: send as never });

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "phone-push-"));
	file = path.join(dir, "push.json");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("PushService", () => {
	it("sends to every subscription and drops gone ones", async () => {
		const send = vi.fn(async (s: { endpoint: string }, _payload: string, _options: unknown) => {
			if (s.endpoint.endsWith("/gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
			if (s.endpoint.endsWith("/missing")) throw Object.assign(new Error("nf"), { statusCode: 404 });
			if (s.endpoint.endsWith("/flaky")) throw Object.assign(new Error("busy"), { statusCode: 503 });
			return { statusCode: 201, body: "", headers: {} };
		});
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const push = service(send);
		for (const n of ["a", "gone", "missing", "flaky", "b"]) push.subscribe(sub(n));
		await push.notify(PAYLOAD);
		spy.mockRestore();
		expect(send).toHaveBeenCalledTimes(5);
		expect(JSON.parse(String(send.mock.calls[0]?.[1]))).toEqual(PAYLOAD);
		expect(send.mock.calls[0]?.[2]).toMatchObject({ vapidDetails: VAPID });
		const saved = JSON.parse(await readFile(file, "utf8")) as PushSubscriptionJSON[];
		expect(saved.map((s) => s.endpoint)).toEqual(["https://push.example/a", "https://push.example/flaky", "https://push.example/b"]);
	});

	it("keeps subscriptions across restarts, replaces by endpoint and unsubscribes", () => {
		const first = service();
		first.subscribe(sub("a"));
		first.subscribe({ ...sub("a"), keys: { p256dh: "new", auth: "new" } });
		first.subscribe(sub("b"));
		const second = service();
		expect(second.list()).toHaveLength(2);
		expect(second.list()[0]?.keys.auth).toBe("new");
		second.unsubscribe("https://push.example/a");
		expect(service().list().map((s) => s.endpoint)).toEqual(["https://push.example/b"]);
	});

	it("starts empty when the file is corrupt", async () => {
		await writeFile(file, "{not json");
		expect(service().list()).toEqual([]);
	});
});
