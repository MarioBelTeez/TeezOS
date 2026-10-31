import { afterEach, describe, expect, test, vi } from "vitest";
import { postJson, request } from "./api.ts";

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("request", () => {
	test("reports offline on a network error", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Load failed"))));
		const result = await request("/api/chats");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.offline).toBe(true);
		expect(result.error).toMatch(/offline|reach/i);
	});

	test("returns the parsed body when the server answers ok", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => json(200, [{ id: "a" }])));
		expect(await request<{ id: string }[]>("/api/chats")).toEqual({ ok: true, data: [{ id: "a" }] });
	});

	test("passes the server's error message through, not offline", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => json(409, { error: "Claude needs a token on the server (claude setup-token)." })));
		expect(await request("/api/chats", { method: "POST" })).toEqual({
			ok: false,
			error: "Claude needs a token on the server (claude setup-token).",
			offline: false,
			status: 409,
		});
	});

	test("names the status when an error has no JSON body", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
		expect(await request("/api/server")).toEqual({ ok: false, error: "The server answered 502.", offline: false, status: 502 });
	});

	test("postJson sends a JSON body with its content type", async () => {
		const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => json(202, {}));
		vi.stubGlobal("fetch", fetchMock);
		await postJson("/api/chats/x/messages", { text: "hi" });
		const [path, init] = fetchMock.mock.calls[0] ?? [];
		expect(path).toBe("/api/chats/x/messages");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBe(JSON.stringify({ text: "hi" }));
		expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
	});
});
