import { describe, expect, test, vi } from "vitest";
import { generateGroq, GROQ_MAX_SOURCE_CHARS, listGroqModels, pickGroqModel } from "./groq.ts";
import type { FetchFn } from "../net.ts";

const KEY = "gsk_TESTKEY1234567890abcdefghij";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const reply = (body: unknown, status = 200, headers?: Record<string, string>): FetchFn => vi.fn<FetchFn>(async () => json(body, status, headers));
const input = { system: "SYS (JSON only)", user: "USER" };
const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

describe("pickGroqModel", () => {
	const id = (value: string, extra: Record<string, unknown> = {}) => ({ id: value, label: value, ...extra });

	test("prefers gpt-oss-120b when it is listed", () => {
		expect(pickGroqModel([id("llama-3.3-70b-versatile"), id("openai/gpt-oss-120b"), id("openai/gpt-oss-20b")])).toBe("openai/gpt-oss-120b");
	});

	test("else another large model, else the first", () => {
		expect(pickGroqModel([id("llama-3.1-8b-instant"), id("llama-3.3-70b-versatile")])).toBe("llama-3.3-70b-versatile");
		expect(pickGroqModel([id("some-small-model")])).toBe("some-small-model");
		expect(pickGroqModel([])).toBeNull();
	});
});

describe("listGroqModels", () => {
	test("asks the fixed host with a bearer header", async () => {
		const fetchFn = reply({ data: [] });
		await listGroqModels(fetchFn, KEY);
		const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
		expect(url).toBe("https://api.groq.com/openai/v1/models");
		expect((init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${KEY}`);
		expect(init.redirect).toBe("error");
	});

	test("keeps chat models and drops speech, guard and inactive ones", async () => {
		const result = await listGroqModels(
			reply({
				data: [
					model("openai/gpt-oss-120b", { active: true }),
					model("whisper-large-v3"),
					model("meta-llama/llama-guard-4-12b"),
					model("playai-tts"),
					model("llama-3.3-70b-versatile", { active: false }),
					model("llama-3.1-8b-instant"),
					model("../bad"),
				],
			}),
			KEY,
		);
		expect(result).toEqual({
			ok: true,
			models: [
				{ id: "openai/gpt-oss-120b", label: "openai/gpt-oss-120b" },
				{ id: "llama-3.1-8b-instant", label: "llama-3.1-8b-instant" },
			],
		});
	});

	test("a rejected key is an auth failure that does not echo the key", async () => {
		const result = await listGroqModels(reply({ error: { message: `Invalid API Key ${KEY}`, type: "invalid_request_error" } }, 401), KEY);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("auth");
		expect(result.error).not.toContain(KEY);
	});
});

describe("generateGroq", () => {
	const ok = { choices: [{ message: { role: "assistant", content: '{"title":"T"}' }, finish_reason: "stop" }] };

	test("posts a JSON-mode chat completion with no tools", async () => {
		const fetchFn = reply(ok);
		const result = await generateGroq(fetchFn, KEY, "openai/gpt-oss-120b", input);
		expect(result).toEqual({ ok: true, text: '{"title":"T"}' });
		const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
		expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
		expect(init.method).toBe("POST");
		const body = JSON.parse(String(init.body)) as Record<string, any>;
		expect(body["model"]).toBe("openai/gpt-oss-120b");
		expect(body["messages"]).toEqual([
			{ role: "system", content: "SYS (JSON only)" },
			{ role: "user", content: "USER" },
		]);
		expect(body["response_format"]).toEqual({ type: "json_object" });
		expect(body).not.toHaveProperty("tools");
		expect(String(init.body)).not.toContain(KEY);
	});

	test("cannot read a PDF, and says what to do", async () => {
		const fetchFn = reply(ok);
		const result = await generateGroq(fetchFn, KEY, "m", { ...input, pdf: new Uint8Array([1]) });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/PDF/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("refuses a model id that could change the request", async () => {
		const result = await generateGroq(reply(ok), KEY, "x\ny", input);
		expect(result.ok).toBe(false);
	});

	test("429 is a quota failure with the retry hint", async () => {
		const result = await generateGroq(reply({ error: { message: "Rate limit reached for model on tokens per minute (TPM)" } }, 429, { "retry-after": "12" }), KEY, "m", input);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("quota");
		expect(result.error).toContain("tokens per minute");
		expect(result.error).toContain("12 seconds");
	});

	test("413 and 400 are invalid-request failures, 5xx is transient", async () => {
		for (const [status, kind] of [[413, "invalid"], [400, "invalid"], [500, "other"], [502, "other"]] as const) {
			const result = await generateGroq(reply({ error: { message: "x" } }, status), KEY, "m", input);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.kind, String(status)).toBe(kind);
		}
	});

	test("an empty or unreadable answer is a failure", async () => {
		expect((await generateGroq(reply({ choices: [] }), KEY, "m", input)).ok).toBe(false);
		expect((await generateGroq(reply({ choices: [{ message: { content: "  " } }] }), KEY, "m", input)).ok).toBe(false);
		const html: FetchFn = async () => new Response("<html>", { status: 200 });
		expect((await generateGroq(html, KEY, "m", input)).ok).toBe(false);
	});

	test("exposes a source limit well under the model's context", () => {
		expect(GROQ_MAX_SOURCE_CHARS).toBeLessThan(120_000);
	});
});
