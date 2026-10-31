import type { ModelInfo } from "../../../shared/feed-engine.ts";
import { isModelId } from "../../../shared/feed-engine.ts";
import type { FetchFn } from "../net.ts";
import { apiRequest, fail, isFailure, statusFailure, type Failure } from "./http.ts";

/**
 * Gemini over REST: generativelanguage.googleapis.com, the key in the
 * x-goog-api-key header (never in the URL), JSON response mode, no tools.
 */

export const GEMINI_HOST = "generativelanguage.googleapis.com";
const BASE = `https://${GEMINI_HOST}/v1beta`;
const LIST_TIMEOUT_MS = 20_000;
const GENERATE_TIMEOUT_MS = 180_000;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
/** Gemini accepts about 20 MB of inline data per request, base64 included. */
const MAX_INLINE_PDF_BYTES = 14 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 32_768;
/** Thinking is capped so a long source does not use the answer's token budget up (finishReason MAX_TOKENS). */
const THINKING_BUDGET = 1024;

export type GenerateInput = { readonly system: string; readonly user: string; readonly pdf?: Uint8Array };
export type Generated = { readonly ok: true; readonly text: string } | Failure;
export type ModelList = { readonly ok: true; readonly models: readonly ModelInfo[] } | Failure;

const isBag = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const headers = (key: string): Record<string, string> => ({ "x-goog-api-key": key, "content-type": "application/json" });

function parse(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

export async function listGeminiModels(fetchFn: FetchFn, key: string, signal?: AbortSignal): Promise<ModelList> {
	const reply = await apiRequest(fetchFn, `${BASE}/models?pageSize=1000`, { method: "GET", headers: headers(key) }, { host: GEMINI_HOST, timeoutMs: LIST_TIMEOUT_MS, maxBytes: MAX_LIST_BYTES, signal, secret: key });
	if (isFailure(reply)) return reply;
	if (reply.status !== 200) return statusFailure("Gemini", "", reply, key);
	const data = parse(reply.body);
	const list = isBag(data) && Array.isArray(data["models"]) ? data["models"] : null;
	if (!list) return fail("other", "Gemini's model list was not readable.");
	const models: ModelInfo[] = [];
	for (const entry of list) {
		if (!isBag(entry) || typeof entry["name"] !== "string") continue;
		const id = entry["name"].replace(/^models\//, "");
		const methods = Array.isArray(entry["supportedGenerationMethods"]) ? entry["supportedGenerationMethods"] : [];
		if (!id.startsWith("gemini") || !isModelId(id) || !methods.includes("generateContent") || /embedding/.test(id)) continue;
		models.push({ id, label: typeof entry["displayName"] === "string" && entry["displayName"] ? entry["displayName"] : id });
	}
	return { ok: true, models };
}

/** Variants that are not for reading text. */
const NOT_TEXT = /(lite|image|tts|live|audio|vision|robotics|computer|embedding|native|thinking|exp)/;

/** `gemini-2.5-flash` to 2.5; 0 when the id has no version. */
function versionOf(id: string): number {
	const match = /gemini-(\d+(?:\.\d+)?)/.exec(id);
	return match ? Number.parseFloat(match[1] ?? "0") : 0;
}

/** The newest Flash (stable before preview of the same version), else any Gemini model, else null. */
export function pickGeminiModel(models: readonly ModelInfo[]): string | null {
	const flash = models.filter((m) => /flash/.test(m.id) && !NOT_TEXT.test(m.id));
	const best = [...flash].sort((a, b) => {
		const byVersion = versionOf(b.id) - versionOf(a.id);
		if (byVersion !== 0) return byVersion;
		const preview = (id: string): number => (/preview/.test(id) ? 1 : 0);
		return preview(a.id) - preview(b.id) || a.id.length - b.id.length;
	})[0];
	return best?.id ?? models[0]?.id ?? null;
}

function requestBody(input: GenerateInput): string {
	const parts: Record<string, unknown>[] = [{ text: input.user }];
	if (input.pdf) parts.push({ inlineData: { mimeType: "application/pdf", data: Buffer.from(input.pdf).toString("base64") } });
	return JSON.stringify({
		systemInstruction: { parts: [{ text: input.system }] },
		contents: [{ role: "user", parts }],
		generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingBudget: THINKING_BUDGET } },
	});
}

/** The reply's text parts, joined (thought summaries skipped), or a failure when there is none. */
function replyText(data: unknown): Generated {
	if (!isBag(data)) return fail("other", "Gemini's answer was not readable.");
	const feedback = data["promptFeedback"];
	const blocked = isBag(feedback) && typeof feedback["blockReason"] === "string" ? feedback["blockReason"] : null;
	if (blocked) return fail("invalid", `Gemini blocked this source (${blocked}).`);
	const candidate = Array.isArray(data["candidates"]) ? data["candidates"][0] : undefined;
	const content = isBag(candidate) ? candidate["content"] : undefined;
	const parts = isBag(content) && Array.isArray(content["parts"]) ? content["parts"] : [];
	const text = parts
		.filter((part): part is Record<string, unknown> => isBag(part) && part["thought"] !== true && typeof part["text"] === "string")
		.map((part) => String(part["text"]))
		.join("");
	if (text.trim()) return { ok: true, text };
	const reason = isBag(candidate) && typeof candidate["finishReason"] === "string" ? ` (${candidate["finishReason"]})` : "";
	return fail("other", `Gemini returned no text${reason}.`);
}

export async function generateGemini(fetchFn: FetchFn, key: string, model: string, input: GenerateInput, signal?: AbortSignal): Promise<Generated> {
	if (!isModelId(model)) return fail("invalid", "That is not a valid Gemini model name.");
	if (input.pdf && input.pdf.byteLength > MAX_INLINE_PDF_BYTES) return fail("invalid", "The PDF is too large to send to Gemini (14 MB at most).");
	const reply = await apiRequest(
		fetchFn,
		`${BASE}/models/${model}:generateContent`,
		{ method: "POST", headers: headers(key), body: requestBody(input) },
		{ host: GEMINI_HOST, timeoutMs: GENERATE_TIMEOUT_MS, maxBytes: MAX_ANSWER_BYTES, signal, secret: key },
	);
	if (isFailure(reply)) return reply;
	if (reply.status !== 200) return statusFailure("Gemini", model, reply, key);
	return replyText(parse(reply.body));
}
