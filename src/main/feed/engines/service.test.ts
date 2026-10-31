import { describe, expect, test, vi } from "vitest";
import { createEngineService, type EngineDeps } from "./service.ts";
import type { FetchFn } from "../net.ts";
import type { QueryFn } from "../../claude/service.ts";
import { DEFAULT_FEED_PREFS, type FeedPrefs } from "../../../shared/feed-engine.ts";
import { newItem } from "../../../shared/feed.ts";

const GKEY = "AIzaSyTESTKEY1234567890abcdefghij";
const QKEY = "gsk_TESTKEY1234567890abcdefghij";
const item = newItem("a", "https://example.com/post", "auto", "", 1)!;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const geminiModels = {
	models: [
		{ name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
	],
};
const geminiAnswer = { candidates: [{ content: { parts: [{ text: '{"title":"T"}' }] } }] };
const groqModels = { data: [{ id: "llama-3.3-70b-versatile" }, { id: "openai/gpt-oss-120b" }] };
const groqAnswer = { choices: [{ message: { content: '{"title":"G"}' } }] };

/** A fetch that answers by URL and records what it was asked. */
function router(routes: Record<string, () => Response>): FetchFn & { calls: { url: string; body: string }[] } {
	const calls: { url: string; body: string }[] = [];
	const fn = (async (url: string, init: RequestInit) => {
		calls.push({ url, body: String(init.body ?? "") });
		for (const [part, answer] of Object.entries(routes)) if (url.includes(part)) return answer();
		return json({ error: { message: "no route" } }, 404);
	}) as FetchFn & { calls: { url: string; body: string }[] };
	fn.calls = calls;
	return fn;
}

function setup(options: Partial<Omit<EngineDeps, "prefs">> & { prefs?: FeedPrefs } = {}) {
	const { prefs, ...over } = options;
	const query = vi.fn<QueryFn>();
	const deps: EngineDeps = {
		fetch: router({ "generativelanguage.googleapis.com/v1beta/models?": () => json(geminiModels), ":generateContent": () => json(geminiAnswer), "api.groq.com/openai/v1/models": () => json(groqModels), "chat/completions": () => json(groqAnswer) }),
		query,
		claudePath: () => "C:\\claude.exe",
		geminiKey: () => GKEY,
		groqKey: () => QKEY,
		prefs: () => prefs ?? DEFAULT_FEED_PREFS,
		now: () => 1000,
		...over,
	};
	return { service: createEngineService(deps), deps, query };
}
const text = (value: string) => ({ kind: "text", text: value }) as const;
const run = (service: ReturnType<typeof setup>["service"]) => service.complete(item, text("ARTICLE"), ["Hooks"], "C:\\work", new AbortController().signal);

describe("engine choice", () => {
	test("auto with both keys uses Gemini and its newest stable Flash", async () => {
		const { service, deps } = setup();
		const out = await run(service);
		expect(out).toEqual({ ok: true, text: '{"title":"T"}', engine: "gemini", model: "gemini-2.5-flash" });
		const calls = (deps.fetch as ReturnType<typeof router>).calls;
		expect(calls.at(-1)?.url).toContain("gemini-2.5-flash:generateContent");
		expect(calls.at(-1)?.body).toContain("ARTICLE");
		expect(calls.at(-1)?.body).toContain("Hooks");
	});

	test("auto with only a Groq key uses Groq with gpt-oss-120b", async () => {
		const { service } = setup({ geminiKey: () => null });
		const out = await run(service);
		expect(out).toEqual({ ok: true, text: '{"title":"G"}', engine: "groq", model: "openai/gpt-oss-120b" });
	});

	test("auto with no key uses Claude", async () => {
		const { service, query } = setup({ geminiKey: () => null, groqKey: () => null });
		query.mockImplementation(() => (async function* () { yield { type: "result", subtype: "success", result: '{"title":"C"}', session_id: "s" }; })());
		const out = await run(service);
		expect(out).toEqual({ ok: true, text: '{"title":"C"}', engine: "claude", model: "sonnet" });
		expect(query.mock.calls[0]?.[0].options["tools"]).toEqual([]);
		expect(query.mock.calls[0]?.[0].options["cwd"]).toBe("C:\\work");
	});

	test("an explicit engine and model are used", async () => {
		const { service } = setup({ prefs: { engine: "groq", models: { gemini: "", groq: "llama-3.3-70b-versatile", claude: "" } } });
		const out = await run(service);
		expect(out.ok && out.model).toBe("llama-3.3-70b-versatile");
		expect(out.ok && out.engine).toBe("groq");
	});

	test("a chosen model that is no longer listed falls back to the default", async () => {
		const { service } = setup({ prefs: { engine: "gemini", models: { gemini: "gemini-1.0-gone", groq: "", claude: "" } } });
		const out = await run(service);
		expect(out.ok && out.model).toBe("gemini-2.5-flash");
	});

	test("the chosen model is used when the list cannot be fetched", async () => {
		const fetchFn = router({ "v1beta/models?": () => json({ error: { message: "down" } }, 503), ":generateContent": () => json(geminiAnswer) });
		const { service } = setup({ fetch: fetchFn, prefs: { engine: "gemini", models: { gemini: "gemini-2.5-pro", groq: "", claude: "" } } });
		const out = await run(service);
		expect(out.ok && out.model).toBe("gemini-2.5-pro");
	});

	test("an engine without its key says what to do", async () => {
		const { service } = setup({ geminiKey: () => null, prefs: { engine: "gemini", models: DEFAULT_FEED_PREFS.models } });
		const out = await run(service);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toMatch(/Gemini key/);
	});

	test("Claude without Claude Code installed says so", async () => {
		const { service } = setup({ claudePath: () => null, prefs: { engine: "claude", models: DEFAULT_FEED_PREFS.models } });
		const out = await run(service);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toMatch(/Claude Code/);
	});
});

describe("source limits", () => {
	test("a long article is cut for Groq much sooner than for Gemini", async () => {
		const long = "z".repeat(100_000);
		const groq = setup({ geminiKey: () => null });
		await groq.service.complete(item, text(long), [], "C:\\work", new AbortController().signal);
		const groqBody = (groq.deps.fetch as ReturnType<typeof router>).calls.at(-1)!.body;
		const gemini = setup();
		await gemini.service.complete(item, text(long), [], "C:\\work", new AbortController().signal);
		const geminiBody = (gemini.deps.fetch as ReturnType<typeof router>).calls.at(-1)!.body;
		expect(groqBody.length).toBeLessThan(geminiBody.length / 2);
		expect(groqBody).toContain("cut at");
	});

	test("a PDF goes to Gemini and is refused by Groq", async () => {
		const pdf = { kind: "pdf", bytes: new Uint8Array([37, 80, 68, 70]) } as const;
		const gemini = setup();
		const sent = await gemini.service.complete(item, pdf, [], "C:\\work", new AbortController().signal);
		expect(sent.ok).toBe(true);
		expect((gemini.deps.fetch as ReturnType<typeof router>).calls.at(-1)?.body).toContain("inlineData");
		const groq = setup({ geminiKey: () => null });
		const refused = await groq.service.complete(item, pdf, [], "C:\\work", new AbortController().signal);
		expect(refused.ok).toBe(false);
	});
});

describe("errors and status", () => {
	test("a quota error is kept as the last error and shown in the status; a later success clears it", async () => {
		let limited = true;
		const fetchFn = router({
			"v1beta/models?": () => json(geminiModels),
			":generateContent": () => (limited ? json({ error: { message: "Quota exceeded" } }, 429) : json(geminiAnswer)),
		});
		const { service } = setup({ fetch: fetchFn });
		const first = await run(service);
		expect(first.ok).toBe(false);
		const status = service.status();
		expect(status.engine).toBe("gemini");
		expect(status.model).toBe("gemini-2.5-flash");
		expect(status.lastError).toMatchObject({ engine: "gemini", at: 1000 });
		expect(status.lastError?.message).toContain("Quota exceeded");
		limited = false;
		await run(service);
		expect(service.status().lastError).toBeNull();
	});

	test("status reports the keys as booleans only", () => {
		const status = setup().service.status();
		expect(status.hasGemini).toBe(true);
		expect(status.hasGroq).toBe(true);
		expect(JSON.stringify(status)).not.toContain(GKEY);
		expect(JSON.stringify(status)).not.toContain(QKEY);
	});

	test("errors never contain either key", async () => {
		const fetchFn = router({ "v1beta/models?": () => json(geminiModels), ":generateContent": () => json({ error: { message: `bad key ${GKEY}` } }, 400) });
		const out = await run(setup({ fetch: fetchFn }).service);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).not.toContain(GKEY);
	});
});

describe("models", () => {
	test("lists an engine's models from its endpoint, Claude's from a fixed list", async () => {
		const { service } = setup();
		const gemini = await service.models("gemini");
		expect(gemini.ok && gemini.models.map((m) => m.id)).toEqual(["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"]);
		const groq = await service.models("groq");
		expect(groq.ok && groq.models.map((m) => m.id)).toEqual(["llama-3.3-70b-versatile", "openai/gpt-oss-120b"]);
		const claude = await service.models("claude");
		expect(claude.ok && claude.models[0]?.id).toBe("sonnet");
	});

	test("without a key there is nothing to list, said plainly", async () => {
		const out = await setup({ geminiKey: () => null }).service.models("gemini");
		expect(out.ok).toBe(false);
	});

	test("the list is fetched once, then cached, until the key changes", async () => {
		const { service, deps } = setup();
		await service.models("gemini");
		await service.models("gemini");
		const listCalls = (deps.fetch as ReturnType<typeof router>).calls.filter((c) => c.url.includes("/models?"));
		expect(listCalls).toHaveLength(1);
		service.forget("gemini");
		await service.models("gemini");
		expect((deps.fetch as ReturnType<typeof router>).calls.filter((c) => c.url.includes("/models?"))).toHaveLength(2);
	});
});
