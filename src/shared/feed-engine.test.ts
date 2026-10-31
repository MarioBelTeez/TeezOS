import { describe, expect, test } from "vitest";
import { chooseEngine, DEFAULT_FEED_PREFS, isGeminiKey, isModelId, normalizePrefs } from "./feed-engine.ts";

describe("chooseEngine", () => {
	test("auto: Gemini when a Gemini key exists", () => {
		expect(chooseEngine("auto", { gemini: true, groq: true })).toBe("gemini");
		expect(chooseEngine("auto", { gemini: true, groq: false })).toBe("gemini");
	});

	test("auto: Groq when only a Groq key exists", () => {
		expect(chooseEngine("auto", { gemini: false, groq: true })).toBe("groq");
	});

	test("auto: Claude when there is no key", () => {
		expect(chooseEngine("auto", { gemini: false, groq: false })).toBe("claude");
	});

	test("an explicit choice is kept, key or not", () => {
		expect(chooseEngine("claude", { gemini: true, groq: true })).toBe("claude");
		expect(chooseEngine("groq", { gemini: false, groq: false })).toBe("groq");
		expect(chooseEngine("gemini", { gemini: false, groq: false })).toBe("gemini");
	});
});

describe("isGeminiKey", () => {
	test("accepts an AI Studio style key", () => {
		expect(isGeminiKey("AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q")).toBe(true);
	});

	test("refuses spaces, control characters, short and long values, non-strings", () => {
		for (const bad of ["", "short", "AIza with space 1234567890123456", "AIza\n1234567890123456789012", "x".repeat(201), 5, null, undefined]) {
			expect(isGeminiKey(bad), String(bad)).toBe(false);
		}
		expect(isGeminiKey("a".repeat(200))).toBe(true);
	});
});

describe("isModelId", () => {
	test("accepts model ids of both engines and refuses anything that could alter a URL", () => {
		for (const ok of ["gemini-2.5-flash", "openai/gpt-oss-120b", "llama-3.3-70b-versatile", "sonnet"]) expect(isModelId(ok), ok).toBe(true);
		for (const bad of ["", "a b", "../x", "x?y=1", "x#y", "a".repeat(101), "x\n", 3]) expect(isModelId(bad), String(bad)).toBe(false);
	});
});

describe("normalizePrefs", () => {
	test("defaults for anything unreadable", () => {
		expect(normalizePrefs(null)).toEqual(DEFAULT_FEED_PREFS);
		expect(normalizePrefs("x")).toEqual(DEFAULT_FEED_PREFS);
		expect(normalizePrefs({ engine: "chatgpt", models: 3 })).toEqual(DEFAULT_FEED_PREFS);
	});

	test("keeps a valid engine and valid model ids, drops invalid ones", () => {
		const prefs = normalizePrefs({ engine: "groq", models: { gemini: "gemini-2.5-flash", groq: "../evil", claude: 4 } });
		expect(prefs).toEqual({ engine: "groq", models: { gemini: "gemini-2.5-flash", groq: "", claude: "" } });
	});
});
