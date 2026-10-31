import { describe, expect, test, vi } from "vitest";
import { generateGemini, listGeminiModels, pickGeminiModel } from "./gemini.ts";
import type { FetchFn } from "../net.ts";

const KEY = "AIzaSyTESTKEY1234567890abcdefghij";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const reply = (body: unknown, status = 200, headers?: Record<string, string>): FetchFn => vi.fn<FetchFn>(async () => json(body, status, headers));
const input = { system: "SYS", user: "USER" };

describe("pickGeminiModel", () => {
	const id = (value: string) => ({ id: value, label: value });

	test("takes the newest Flash, preferring stable over preview", () => {
		const models = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3-flash-preview", "gemini-2.5-flash-image"].map(id);
		expect(pickGeminiModel(models)).toBe("gemini-3-flash-preview");
		expect(pickGeminiModel(models.filter((m) => !m.id.includes("3-flash")))).toBe("gemini-2.5-flash");
	});

	test("prefers a stable model over a preview of the same version", () => {
		expect(pickGeminiModel([id("gemini-2.5-flash-preview-05-20"), id("gemini-2.5-flash")])).toBe("gemini-2.5-flash");
	});

	test("skips Lite, image, audio and live variants", () => {
		expect(pickGeminiModel([id("gemini-3-flash-lite"), id("gemini-3-flash-live"), id("gemini-2.0-flash")])).toBe("gemini-2.0-flash");
	});

	test("falls back to any Gemini model, and to null for none", () => {
		expect(pickGeminiModel([id("gemini-2.5-pro")])).toBe("gemini-2.5-pro");
		expect(pickGeminiModel([])).toBeNull();
	});
});

describe("listGeminiModels", () => {
	test("asks the fixed host with the key in a header, never in the URL", async () => {
		const fetchFn = reply({ models: [] });
		await listGeminiModels(fetchFn, KEY);
		const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
		expect(new URL(url).hostname).toBe("generativelanguage.googleapis.com");
		expect(new URL(url).protocol).toBe("https:");
		expect(url).not.toContain(KEY);
		expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
		expect(init.redirect).toBe("error");
	});

	test("keeps Gemini models that can generate content, with their display names", async () => {
		const result = await listGeminiModels(
			reply({
				models: [
					{ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
					{ name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
					{ name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
					{ name: "models/gemma-3-27b-it", supportedGenerationMethods: ["generateContent"] },
					{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
					{ name: "bad", supportedGenerationMethods: ["generateContent"] },
				],
			}),
			KEY,
		);
		expect(result).toEqual({
			ok: true,
			models: [
				{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
				{ id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
			],
		});
	});

	test("maps a rejected key to an auth failure without echoing the key", async () => {
		const result = await listGeminiModels(reply({ error: { code: 400, message: `API key not valid. ${KEY}`, status: "INVALID_ARGUMENT" } }, 400), KEY);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("auth");
		expect(result.error).not.toContain(KEY);
	});

	test("a network error is a failure that names the host, not the key", async () => {
		const fetchFn: FetchFn = async () => {
			throw new TypeError(`fetch failed ${KEY}`);
		};
		const result = await listGeminiModels(fetchFn, KEY);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("network");
		expect(result.error).toContain("generativelanguage.googleapis.com");
		expect(result.error).not.toContain(KEY);
	});
});

describe("generateGemini", () => {
	const ok = { candidates: [{ content: { parts: [{ text: '{"title":"T"}' }] }, finishReason: "STOP" }] };

	test("posts the prompt to generateContent in JSON mode", async () => {
		const fetchFn = reply(ok);
		const result = await generateGemini(fetchFn, KEY, "gemini-2.5-flash", input);
		expect(result).toEqual({ ok: true, text: '{"title":"T"}' });
		const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
		expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
		expect(init.method).toBe("POST");
		const body = JSON.parse(String(init.body)) as Record<string, any>;
		expect(body["systemInstruction"].parts[0].text).toBe("SYS");
		expect(body["contents"][0].parts[0].text).toBe("USER");
		expect(body["generationConfig"].responseMimeType).toBe("application/json");
		expect(body["generationConfig"].thinkingConfig.thinkingBudget).toBeLessThanOrEqual(2048);
		expect(body).not.toHaveProperty("tools");
		expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
		expect(String(init.body)).not.toContain(KEY);
	});

	test("sends a PDF as inline data", async () => {
		const fetchFn = reply(ok);
		await generateGemini(fetchFn, KEY, "gemini-2.5-flash", { ...input, pdf: new Uint8Array([37, 80, 68, 70]) });
		const body = JSON.parse(String(vi.mocked(fetchFn).mock.calls[0]![1].body)) as Record<string, any>;
		expect(body["contents"][0].parts[1].inlineData).toEqual({ mimeType: "application/pdf", data: "JVBERg==" });
	});

	test("refuses a PDF too large to send inline", async () => {
		const fetchFn = reply(ok);
		const result = await generateGemini(fetchFn, KEY, "gemini-2.5-flash", { ...input, pdf: new Uint8Array(16 * 1024 * 1024) });
		expect(result.ok).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("refuses a model id that could change the URL", async () => {
		const fetchFn = reply(ok);
		const result = await generateGemini(fetchFn, KEY, "x/../../v1/files", input);
		expect(result.ok).toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("joins the text parts and skips thought parts", async () => {
		const result = await generateGemini(reply({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "{" }, { text: "}" }] } }] }), KEY, "m", input);
		expect(result).toEqual({ ok: true, text: "{}" });
	});

	test("a blocked prompt and an empty answer are failures", async () => {
		const blocked = await generateGemini(reply({ promptFeedback: { blockReason: "SAFETY" } }), KEY, "m", input);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error).toContain("SAFETY");
		const empty = await generateGemini(reply({ candidates: [{ finishReason: "SAFETY" }] }), KEY, "m", input);
		expect(empty.ok).toBe(false);
	});

	test("429 is a quota failure that mentions when to retry", async () => {
		const result = await generateGemini(reply({ error: { code: 429, message: "Quota exceeded for metric", status: "RESOURCE_EXHAUSTED" } }, 429, { "retry-after": "30" }), KEY, "m", input);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("quota");
		expect(result.error).toContain("Quota exceeded");
		expect(result.error).toContain("30 seconds");
	});

	test("401, 404, 413 and 500 map to clear failures", async () => {
		const kinds = new Map<number, string>([
			[401, "auth"],
			[403, "auth"],
			[404, "invalid"],
			[413, "invalid"],
			[500, "other"],
			[503, "other"],
		]);
		for (const [status, kind] of kinds) {
			const result = await generateGemini(reply({ error: { message: "nope" } }, status), KEY, "m", input);
			expect(result.ok, String(status)).toBe(false);
			if (!result.ok) expect(result.kind, String(status)).toBe(kind);
		}
	});

	test("a body that is not JSON is a failure, not a crash", async () => {
		const fetchFn: FetchFn = async () => new Response("<html>oops</html>", { status: 200 });
		const result = await generateGemini(fetchFn, KEY, "m", input);
		expect(result.ok).toBe(false);
	});

	test("an oversized answer is dropped", async () => {
		const fetchFn: FetchFn = async () => new Response("x".repeat(9 * 1024 * 1024), { status: 200 });
		const result = await generateGemini(fetchFn, KEY, "m", input);
		expect(result.ok).toBe(false);
	});

	test("cancelling stops the request", async () => {
		const controller = new AbortController();
		const fetchFn: FetchFn = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		const pending = generateGemini(fetchFn, KEY, "m", input, controller.signal);
		controller.abort();
		const result = await pending;
		expect(result).toEqual({ ok: false, kind: "other", error: "Cancelled." });
	});
});
