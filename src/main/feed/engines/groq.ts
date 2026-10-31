import { isModelId, type ModelInfo } from "../../../shared/feed-engine.ts";
import type { FetchFn } from "../net.ts";
import { apiRequest, fail, isFailure, statusFailure } from "./http.ts";
import type { Generated, GenerateInput, ModelList } from "./gemini.ts";

/**
 * Groq over its OpenAI-compatible REST API: api.groq.com, a bearer key, JSON
 * mode, no tools. Groq cannot read PDFs here (no text extraction in TeezAI).
 */

export const GROQ_HOST = "api.groq.com";
const BASE = `https://${GROQ_HOST}/openai/v1`;
const LIST_TIMEOUT_MS = 20_000;
const GENERATE_TIMEOUT_MS = 180_000;
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 8192;
/** Groq's free plans allow few tokens a minute; a source larger than this would be refused (413 / 429). */
export const GROQ_MAX_SOURCE_CHARS = 28_000;

const isBag = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const headers = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });

function parse(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

/** Models that are not for chat. */
const NOT_CHAT = /(whisper|guard|tts|playai|orpheus|embed|safeguard|allam)/i;

export async function listGroqModels(fetchFn: FetchFn, key: string, signal?: AbortSignal): Promise<ModelList> {
	const reply = await apiRequest(fetchFn, `${BASE}/models`, { method: "GET", headers: headers(key) }, { host: GROQ_HOST, timeoutMs: LIST_TIMEOUT_MS, maxBytes: MAX_LIST_BYTES, signal, secret: key });
	if (isFailure(reply)) return reply;
	if (reply.status !== 200) return statusFailure("Groq", "", reply, key);
	const data = parse(reply.body);
	const list = isBag(data) && Array.isArray(data["data"]) ? data["data"] : null;
	if (!list) return fail("other", "Groq's model list was not readable.");
	const models: ModelInfo[] = [];
	for (const entry of list) {
		if (!isBag(entry) || typeof entry["id"] !== "string") continue;
		const id = entry["id"];
		if (!isModelId(id) || NOT_CHAT.test(id) || entry["active"] === false) continue;
		models.push({ id, label: id });
	}
	return { ok: true, models };
}

/** Large open models, best first. */
const PREFERRED: readonly RegExp[] = [/gpt-oss-120b/, /llama-3\.3-70b/, /120b|70b|405b/];

/** gpt-oss-120b when listed, else another large open model, else the first listed. */
export function pickGroqModel(models: readonly ModelInfo[]): string | null {
	for (const pattern of PREFERRED) {
		const found = models.find((m) => pattern.test(m.id));
		if (found) return found.id;
	}
	return models[0]?.id ?? null;
}

export async function generateGroq(fetchFn: FetchFn, key: string, model: string, input: GenerateInput, signal?: AbortSignal): Promise<Generated> {
	if (input.pdf) return fail("invalid", "Groq cannot read PDFs. Use Gemini for PDFs, or link the article page instead.");
	if (!isModelId(model)) return fail("invalid", "That is not a valid Groq model name.");
	const body = JSON.stringify({
		model,
		messages: [
			{ role: "system", content: input.system },
			{ role: "user", content: input.user },
		],
		response_format: { type: "json_object" },
		temperature: 0.2,
		max_completion_tokens: MAX_OUTPUT_TOKENS,
	});
	const reply = await apiRequest(fetchFn, `${BASE}/chat/completions`, { method: "POST", headers: headers(key), body }, { host: GROQ_HOST, timeoutMs: GENERATE_TIMEOUT_MS, maxBytes: MAX_ANSWER_BYTES, signal, secret: key });
	if (isFailure(reply)) return reply;
	if (reply.status !== 200) return statusFailure("Groq", model, reply, key);
	const data = parse(reply.body);
	const choice = isBag(data) && Array.isArray(data["choices"]) ? data["choices"][0] : undefined;
	const message = isBag(choice) ? choice["message"] : undefined;
	const text = isBag(message) && typeof message["content"] === "string" ? message["content"] : "";
	return text.trim() ? { ok: true, text } : fail("other", "Groq returned no text.");
}
