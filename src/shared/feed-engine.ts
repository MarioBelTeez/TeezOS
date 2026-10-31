import { isBag } from "./normalize.ts";

/**
 * Which model reads a fed source: the three engines, how the default is
 * chosen, and the saved choice. Shared with the Settings page; the keys
 * themselves never leave the main process.
 */

export type EngineId = "gemini" | "groq" | "claude";
export type EngineChoice = "auto" | EngineId;
export const ENGINE_IDS: readonly EngineId[] = ["gemini", "groq", "claude"];
export const ENGINE_LABEL: Readonly<Record<EngineId, string>> = { gemini: "Gemini", groq: "Groq", claude: "Claude" };

export type FeedPrefs = {
	readonly engine: EngineChoice;
	/** The model per engine; "" means the engine's default. */
	readonly models: Readonly<Record<EngineId, string>>;
};

export const DEFAULT_FEED_PREFS: FeedPrefs = { engine: "auto", models: { gemini: "", groq: "", claude: "" } };

export type ModelInfo = { readonly id: string; readonly label: string };

/** The last quota or rate error an engine reported, shown in the Feed view. */
export type EngineError = { readonly engine: EngineId; readonly message: string; readonly at: number };

/** What the Feed view shows about the engine in use. */
export type EngineStatus = {
	readonly choice: EngineChoice;
	readonly engine: EngineId;
	/** The model that will be used ("" while the default is not resolved yet). */
	readonly model: string;
	readonly hasGemini: boolean;
	readonly hasGroq: boolean;
	readonly lastError: EngineError | null;
};

/** Longest Gemini key accepted. */
export const MAX_GEMINI_KEY = 200;
const MIN_GEMINI_KEY = 20;

/** A Gemini (AI Studio) key: printable characters only, no spaces, 20 to 200 of them. */
export function isGeminiKey(value: unknown): value is string {
	return typeof value === "string" && value.length >= MIN_GEMINI_KEY && value.length <= MAX_GEMINI_KEY && /^[\x21-\x7e]+$/.test(value);
}

/** A model id as the engines name them (`gemini-2.5-flash`, `openai/gpt-oss-120b`): nothing that could change a URL. */
export function isModelId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(value) && !value.includes("..");
}

/** The default engine: Gemini if there is a Gemini key, else Groq if there is a Groq key, else Claude. An explicit choice stays. */
export function chooseEngine(choice: EngineChoice, keys: { readonly gemini: boolean; readonly groq: boolean }): EngineId {
	if (choice !== "auto") return choice;
	if (keys.gemini) return "gemini";
	if (keys.groq) return "groq";
	return "claude";
}

export function isEngineChoice(value: unknown): value is EngineChoice {
	return value === "auto" || (typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value));
}

export function normalizePrefs(raw: unknown): FeedPrefs {
	if (!isBag(raw)) return DEFAULT_FEED_PREFS;
	const models = isBag(raw["models"]) ? raw["models"] : {};
	const model = (id: EngineId): string => {
		const value = models[id];
		return isModelId(value) ? value : "";
	};
	return {
		engine: isEngineChoice(raw["engine"]) ? raw["engine"] : "auto",
		models: { gemini: model("gemini"), groq: model("groq"), claude: model("claude") },
	};
}
