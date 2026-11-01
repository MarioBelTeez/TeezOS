import { describe, expect, test } from "vitest";
import { effortLabel, effortOptions, isEffort } from "./effort.ts";

describe("effort", () => {
	test("Claude has Claude Code's levels plus the model default; Antigravity has three", () => {
		expect(effortOptions("claude").map((o) => o.id)).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
		expect(effortOptions("agy").map((o) => o.id)).toEqual(["low", "medium", "high"]);
	});

	test("only an agent's own levels are valid", () => {
		expect(isEffort("claude", "max")).toBe(true);
		expect(isEffort("claude", "")).toBe(true);
		expect(isEffort("agy", "max")).toBe(false);
		expect(isEffort("agy", "")).toBe(false);
		expect(isEffort("claude", "ultra")).toBe(false);
		expect(isEffort("claude", 3)).toBe(false);
	});

	test("Codex offers low, medium and high: the levels every Codex model supports", () => {
		expect(effortOptions("codex").map((o) => o.id)).toEqual(["low", "medium", "high"]);
		expect(isEffort("codex", "high")).toBe(true);
		expect(isEffort("codex", "max")).toBe(false);
		expect(isEffort("codex", "")).toBe(false);
	});

	test("labels", () => {
		expect(effortLabel("claude", "")).toBe("Default");
		expect(effortLabel("claude", "xhigh")).toBe("Extra high");
		expect(effortLabel("agy", "high")).toBe("High");
	});
});
