import { describe, expect, test } from "vitest";
import { emptyModelsItem } from "./agent-options.ts";

describe("emptyModelsItem", () => {
	test("Gemini keeps its line", () => {
		expect(emptyModelsItem("agy", null)).toEqual({ label: "  No Gemini models", hint: "none listed by Antigravity" });
	});
	test("an empty Codex group says what to do", () => {
		expect(emptyModelsItem("codex", "codex-not-found")).toEqual({ label: "  Codex not installed", hint: "npm i -g @openai/codex, then codex login" });
		expect(emptyModelsItem("codex", "codex-logged-out")).toEqual({ label: "  Codex not logged in", hint: "run codex login in the terminal" });
		expect(emptyModelsItem("codex", "codex-unsupported")).toEqual({ label: "  Codex version not supported", hint: "install the version TeezOS supports" });
		expect(emptyModelsItem("codex", null)).toEqual({ label: "  No Codex models", hint: "none listed by Codex" });
	});
});

import { needsLogin } from "./agent-options.ts";

describe("needsLogin", () => {
	test("Claude's logged-out errors and Codex's login-related ones offer the login button", () => {
		expect(needsLogin("authentication_failed", "")).toBe(true);
		expect(needsLogin("", "Please log in")).toBe(true);
		expect(needsLogin("codex-logged-out", "")).toBe(true);
		expect(needsLogin("codex-start", "")).toBe(true);
		expect(needsLogin("codex-not-found", "")).toBe(false);
		expect(needsLogin("overloaded", "busy")).toBe(false);
	});
});
