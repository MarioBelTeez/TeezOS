import { chooseEngine, ENGINE_LABEL, type EngineError, type EngineId, type EngineStatus, type FeedPrefs, type ModelInfo } from "../../../shared/feed-engine.ts";
import type { FeedItem } from "../../../shared/feed.ts";
import type { QueryFn } from "../../claude/service.ts";
import { buildPrompt, MAX_SOURCE_CHARS } from "../extract.ts";
import type { FetchFn } from "../net.ts";
import { CLAUDE_MODELS, generateClaude } from "./claude.ts";
import { generateGemini, listGeminiModels, pickGeminiModel, type Generated, type ModelList } from "./gemini.ts";
import { generateGroq, GROQ_MAX_SOURCE_CHARS, listGroqModels, pickGroqModel } from "./groq.ts";
import { fail, type Failure } from "./http.ts";

/**
 * The three engines behind one call: pick the engine (the saved choice, or
 * Gemini, then Groq, then Claude by which key exists), pick the model (the
 * saved one if the account still lists it, else the engine's default), build
 * the prompt for that engine's limits and ask. Keys and the Claude path are
 * read only here, when a request is made, and never leave this module.
 */

/** What the reader returned: text for any engine, or a PDF's bytes (Gemini only). */
export type SourceContent = { readonly kind: "text"; readonly text: string } | { readonly kind: "pdf"; readonly bytes: Uint8Array };

export type Completion =
	| { readonly ok: true; readonly text: string; readonly engine: EngineId; readonly model: string }
	| (Failure & { readonly engine: EngineId });

export type EngineDeps = {
	readonly fetch: FetchFn;
	readonly query: QueryFn;
	readonly claudePath: () => string | null;
	readonly geminiKey: () => string | null;
	readonly groqKey: () => string | null;
	readonly prefs: () => FeedPrefs;
	readonly now: () => number;
};

export type EngineService = {
	readonly complete: (item: FeedItem, source: SourceContent, conceptTitles: readonly string[], workDir: string, signal: AbortSignal) => Promise<Completion>;
	readonly models: (engine: EngineId, signal?: AbortSignal) => Promise<ModelList>;
	readonly status: () => EngineStatus;
	/** Drops the cached model list (the key changed). */
	readonly forget: (engine: EngineId) => void;
};

const MODEL_CACHE_MS = 10 * 60_000;
const SOURCE_LIMIT: Readonly<Record<EngineId, number>> = { gemini: MAX_SOURCE_CHARS, groq: GROQ_MAX_SOURCE_CHARS, claude: MAX_SOURCE_CHARS };
const NO_KEY: Readonly<Record<"gemini" | "groq", string>> = {
	gemini: "No Gemini key is saved. Add one in Settings, Feed (a free key from aistudio.google.com), or pick another engine.",
	groq: "No Groq key is saved. Add one in Settings, Feed, or pick another engine.",
};

/** The model used when none is chosen (or the chosen one is gone): Sonnet, the newest Flash, a large open model. */
export function defaultModel(engine: EngineId, models: readonly ModelInfo[]): string | null {
	if (engine === "claude") return models[0]?.id ?? null;
	return engine === "gemini" ? pickGeminiModel(models) : pickGroqModel(models);
}

export function createEngineService(deps: EngineDeps): EngineService {
	const cache = new Map<EngineId, { readonly list: ModelList & { readonly ok: true }; readonly at: number }>();
	let lastError: EngineError | null = null;

	const keys = (): { gemini: string | null; groq: string | null } => ({ gemini: deps.geminiKey(), groq: deps.groqKey() });
	const engineNow = (): EngineId => {
		const k = keys();
		return chooseEngine(deps.prefs().engine, { gemini: k.gemini !== null, groq: k.groq !== null });
	};

	async function models(engine: EngineId, signal?: AbortSignal): Promise<ModelList> {
		if (engine === "claude") return { ok: true, models: CLAUDE_MODELS };
		const cached = cache.get(engine);
		if (cached && deps.now() - cached.at < MODEL_CACHE_MS) return cached.list;
		const key = engine === "gemini" ? deps.geminiKey() : deps.groqKey();
		if (!key) return fail("auth", NO_KEY[engine]);
		const list = engine === "gemini" ? await listGeminiModels(deps.fetch, key, signal) : await listGroqModels(deps.fetch, key, signal);
		if (list.ok) cache.set(engine, { list, at: deps.now() });
		return list;
	}

	/** The saved model if still listed, else the default; the saved one blind when the list is unavailable. */
	async function modelFor(engine: EngineId, signal: AbortSignal): Promise<string | Failure> {
		const wanted = deps.prefs().models[engine];
		const list = await models(engine, signal);
		if (!list.ok) return wanted || list;
		if (wanted && list.models.some((m) => m.id === wanted)) return wanted;
		return defaultModel(engine, list.models) ?? fail("other", `${ENGINE_LABEL[engine]} lists no model this account can use.`);
	}

	async function generate(engine: EngineId, model: string, system: string, user: string, pdf: Uint8Array | undefined, workDir: string, signal: AbortSignal): Promise<Generated> {
		const input = { system, user, ...(pdf ? { pdf } : {}) };
		if (engine === "claude") {
			const claudePath = deps.claudePath();
			if (!claudePath) return fail("other", "Claude Code was not found on this computer.");
			return generateClaude({ query: deps.query, claudePath, cwd: workDir }, model, input, signal);
		}
		const key = engine === "gemini" ? deps.geminiKey() : deps.groqKey();
		if (!key) return fail("auth", NO_KEY[engine]);
		return engine === "gemini" ? generateGemini(deps.fetch, key, model, input, signal) : generateGroq(deps.fetch, key, model, input, signal);
	}

	async function complete(item: FeedItem, source: SourceContent, conceptTitles: readonly string[], workDir: string, signal: AbortSignal): Promise<Completion> {
		const engine = engineNow();
		const failure = (f: Failure): Completion => ({ ...f, engine });
		const model = await modelFor(engine, signal);
		if (typeof model !== "string") return failure(model);
		const text = source.kind === "text" ? source.text : "";
		const prompt = buildPrompt(item, text, conceptTitles, SOURCE_LIMIT[engine]);
		const out = await generate(engine, model, prompt.system, prompt.user, source.kind === "pdf" ? source.bytes : undefined, workDir, signal);
		if (out.ok) {
			if (lastError?.engine === engine) lastError = null;
			return { ok: true, text: out.text, engine, model };
		}
		if (out.kind === "quota") lastError = { engine, message: out.error, at: deps.now() };
		return failure(out);
	}

	function status(): EngineStatus {
		const prefs = deps.prefs();
		const k = keys();
		const engine = engineNow();
		const cached = cache.get(engine);
		const defaulted = cached ? defaultModel(engine, cached.list.models) : null;
		return {
			choice: prefs.engine,
			engine,
			model: prefs.models[engine] || defaulted || (engine === "claude" ? "sonnet" : ""),
			hasGemini: k.gemini !== null,
			hasGroq: k.groq !== null,
			lastError,
		};
	}

	return { complete, models, status, forget: (engine) => void cache.delete(engine) };
}
