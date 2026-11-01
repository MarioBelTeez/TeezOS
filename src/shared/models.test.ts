import { describe, expect, test } from "vitest";
import {
	CLAUDE_CHOICES,
	agyModelId,
	choiceOf,
	geminiChoices,
	geminiFamily,
	modelChoices,
	modelForChoice,
	modelLabelOf,
	withCurrentOption,
	geminiAtEffort,
} from "./models.ts";

/** What `agy models` listed on 2026-10-14, Claude and GPT entries included. */
const LISTED = [
	{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
	{ id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
	{ id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
	{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
	{ id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
	{ id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

/** A later list: Argon 4 enabled, ahead of Flash in agy's order. */
const WITH_ARGON = [
	{ id: "gemini-argon-4-high", label: "Gemini Argon 4 (High)" },
	{ id: "gemini-argon-4-low", label: "Gemini Argon 4 (Low)" },
	...LISTED,
];

const ids = (list: readonly { id: string }[]): string[] => list.map((m) => m.id);

describe("CLAUDE_CHOICES", () => {
	test("Opus then Sonnet, fixed aliases", () => {
		expect(CLAUDE_CHOICES.map((c) => [c.id, c.label, c.agent])).toEqual([
			["opus", "Opus 5.5", "claude"],
			["sonnet", "Sonnet 5.5", "claude"],
		]);
	});
});

describe("geminiFamily", () => {
	test("strips a trailing thinking level only", () => {
		expect(geminiFamily("gemini-3.8-flash-high")).toBe("gemini-3.8-flash");
		expect(geminiFamily("gemini-3.8-flash-medium")).toBe("gemini-3.8-flash");
		expect(geminiFamily("gemini-3.8-flash")).toBe("gemini-3.8-flash");
		expect(geminiFamily("gemini-high-speed")).toBe("gemini-high-speed");
	});
});

describe("geminiChoices", () => {
	test("groups the effort variants into one choice per family", () => {
		expect(geminiChoices(LISTED)).toEqual([{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", agent: "agy" }]);
	});

	test("ignores everything that is not gemini-*", () => {
		const choices = geminiChoices([
			{ id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
			{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
		]);
		expect(choices).toEqual([]);
	});

	test("keeps Antigravity's order, so the newest it lists comes first", () => {
		expect(ids(geminiChoices(WITH_ARGON))).toEqual(["gemini-argon-4", "gemini-3.8-flash"]);
	});

	test("cleans the label of its thinking level, case-insensitively", () => {
		const choices = geminiChoices([{ id: "gemini-9-pro-low", label: "Gemini 9 Pro (low)" }]);
		expect(choices[0]?.label).toBe("Gemini 9 Pro");
	});

	test("a model without a level suffix is its own family", () => {
		expect(geminiChoices([{ id: "gemini-nano", label: "Gemini Nano" }])).toEqual([{ id: "gemini-nano", label: "Gemini Nano", agent: "agy" }]);
	});

	test("an empty list (agy missing) offers no Gemini", () => {
		expect(geminiChoices([])).toEqual([]);
	});
});

describe("modelChoices", () => {
	test("Claude first, then Gemini as Antigravity lists it", () => {
		expect(ids(modelChoices(WITH_ARGON))).toEqual(["opus", "sonnet", "gemini-argon-4", "gemini-3.8-flash"]);
	});
});

describe("agyModelId", () => {
	const available = [...ids(LISTED), "gemini-argon-4-high", "gemini-argon-4-low"];
	test("exact effort when listed", () => {
		expect(agyModelId("gemini-3.8-flash", "medium", available)).toBe("gemini-3.8-flash-medium");
	});
	test("no medium: medium falls to high, then low", () => {
		expect(agyModelId("gemini-argon-4", "medium", available)).toBe("gemini-argon-4-high");
		expect(agyModelId("gemini-argon-4", "medium", ["gemini-argon-4-low"])).toBe("gemini-argon-4-low");
	});
	test("nothing listed means null", () => {
		expect(agyModelId("gemini-3.8-flash", "high", [])).toBeNull();
	});
});

describe("choiceOf", () => {
	const choices = modelChoices(WITH_ARGON);
	test("claude aliases and the account default map to their choice", () => {
		expect(choiceOf("claude", "opus", choices)?.label).toBe("Opus 5.5");
		expect(choiceOf("claude", "sonnet", choices)?.label).toBe("Sonnet 5.5");
		expect(choiceOf("claude", "", choices)?.label).toBe("Opus 5.5");
	});
	test("claude works without any Antigravity list", () => {
		expect(choiceOf("claude", "sonnet")?.label).toBe("Sonnet 5.5");
	});
	test("agy ids map to their family in the live list", () => {
		expect(choiceOf("agy", "gemini-argon-4-high", choices)?.label).toBe("Gemini Argon 4");
		expect(choiceOf("agy", "gemini-3.8-flash-low", choices)?.label).toBe("Gemini 3.8 Flash");
	});
	test("a family is matched whole, not by prefix", () => {
		const flashLite = modelChoices([{ id: "gemini-3.8-flash-lite-low", label: "Gemini 3.8 Flash Lite (Low)" }]);
		expect(choiceOf("agy", "gemini-3.8-flash-high", flashLite)).toBeUndefined();
		expect(choiceOf("agy", "gemini-3.8-flash-lite-high", flashLite)?.label).toBe("Gemini 3.8 Flash Lite");
	});
	test("a saved model Antigravity no longer lists has no choice (shown by its raw id)", () => {
		expect(choiceOf("agy", "gemini-3.1-pro-high", choices)).toBeUndefined();
		expect(choiceOf("agy", "gpt-oss-120b-medium", choices)).toBeUndefined();
		expect(choiceOf("agy", "", choices)).toBeUndefined();
		expect(choiceOf("claude", "claude-opus-4-20250514", choices)).toBeUndefined();
	});
});

describe("modelForChoice", () => {
	test("claude ids pass through, agy ids get the effort from the live list", () => {
		const [opus, , argon] = modelChoices(WITH_ARGON);
		expect(modelForChoice(opus!, "high", [])).toBe("opus");
		expect(modelForChoice(argon!, "low", ids(WITH_ARGON))).toBe("gemini-argon-4-low");
		expect(modelForChoice(argon!, "low", [])).toBeNull();
	});
});

describe("modelLabelOf", () => {
	const choices = modelChoices(LISTED);
	test("known models by their choice's label", () => {
		expect(modelLabelOf("opus", choices)).toBe("Opus 5.5");
		expect(modelLabelOf("gemini-3.8-flash-medium", choices)).toBe("Gemini 3.8 Flash");
	});
	test("anything else as it came", () => {
		expect(modelLabelOf("gemini-3.1-pro-high", choices)).toBe("gemini-3.1-pro-high");
		expect(modelLabelOf("claude-opus-4-20250514", choices)).toBe("claude-opus-4-20250514");
	});
});

describe("withCurrentOption", () => {
	const options = [
		{ id: "", label: "Default" },
		{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
	];
	test("a listed value leaves the options as they are", () => {
		expect(withCurrentOption(options, "gemini-3.8-flash-high")).toBe(options);
		expect(withCurrentOption(options, "")).toBe(options);
	});
	test("a saved value no longer listed is added as itself, so the select still shows it", () => {
		expect(withCurrentOption(options, "gemini-3.1-pro-high")).toEqual([...options, { id: "gemini-3.1-pro-high", label: "gemini-3.1-pro-high" }]);
	});
});

describe("geminiAtEffort", () => {
	const available = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "gemini-3.1-pro-high"];
	test("the same family at the new level", () => {
		expect(geminiAtEffort("gemini-3.8-flash-medium", "high", available)).toBe("gemini-3.8-flash-high");
		expect(geminiAtEffort("gemini-3.8-flash-high", "low", available)).toBe("gemini-3.8-flash-low");
	});
	test("the nearest level when that one is missing; null when nothing would change", () => {
		expect(geminiAtEffort("gemini-3.1-pro-high", "low", available)).toBeNull();
		expect(geminiAtEffort("gemini-3.8-flash-high", "high", available)).toBeNull();
		expect(geminiAtEffort("", "high", available)).toBeNull();
		expect(geminiAtEffort("gpt-oss-120b", "high", available)).toBeNull();
	});
});

describe("Codex models", () => {
	const codex = [
		{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", agent: "codex" as const },
		{ id: "gpt-5.5", label: "GPT-5.5", agent: "codex" as const },
	];
	const choices = [...CLAUDE_CHOICES, ...codex];

	test("a Codex model is its own choice, by exact id", () => {
		expect(choiceOf("codex", "gpt-5.5", choices)?.label).toBe("GPT-5.5");
		expect(choiceOf("codex", "", choices)).toBeUndefined();
		expect(choiceOf("codex", "opus", choices)).toBeUndefined();
	});

	test("picking a Codex choice uses its id whatever the effort", () => {
		expect(modelForChoice(codex[1]!, "high", [])).toBe("gpt-5.5");
	});

	test("labels a Codex model by its display name", () => {
		expect(modelLabelOf("gpt-6.1-sol", choices)).toBe("GPT-6.1-Sol");
	});
});

describe("modelChoices with Codex", () => {
	test("Codex's models follow Claude's and Gemini's, as Codex choices", () => {
		const choices = modelChoices([], [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }]);
		expect(choices.at(-1)).toEqual({ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", agent: "codex" });
		expect(modelChoices([]).some((c) => c.agent === "codex")).toBe(false);
	});
});
