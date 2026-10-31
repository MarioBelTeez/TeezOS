import type { AgentKind } from "../main/agents/registry.ts";

/**
 * The models the composer offers, in one place. Claude uses Claude Code's
 * aliases, which always mean the newest of that family, so its two choices
 * are fixed. Gemini comes from Antigravity's own list (`agy models`), which
 * changes as Google adds and retires models: one choice per family, its ids
 * carrying a thinking level suffix filled in from the Antigravity effort
 * setting.
 */

export type Effort = "low" | "medium" | "high";
export type ModelChoice = { readonly id: string; readonly label: string; readonly agent: AgentKind };
/** A model as `agy models` lists it. */
export type ListedModel = { readonly id: string; readonly label: string };

export const CLAUDE_CHOICES: readonly ModelChoice[] = [
	{ id: "opus", label: "Opus 5.5", agent: "claude" },
	{ id: "sonnet", label: "Sonnet 5.5", agent: "claude" },
];

const LEVEL_SUFFIX = /-(?:low|medium|high)$/;
const LEVEL_LABEL = /\s*\((?:low|medium|high)\)$/i;

/** "gemini-3.8-flash-high" → "gemini-3.8-flash"; an id without a level is its own family. */
export function geminiFamily(id: string): string {
	return id.replace(LEVEL_SUFFIX, "");
}

/**
 * One choice per Gemini family Antigravity lists, in its order (it lists the
 * newest first). Its Claude and GPT entries are left out: Claude runs through
 * Claude Code here.
 */
export function geminiChoices(available: readonly ListedModel[]): ModelChoice[] {
	const choices: ModelChoice[] = [];
	for (const model of available) {
		if (!model.id.startsWith("gemini-")) continue;
		const id = geminiFamily(model.id);
		if (choices.some((c) => c.id === id)) continue;
		choices.push({ id, label: model.label.replace(LEVEL_LABEL, ""), agent: "agy" });
	}
	return choices;
}

/** Everything the model picker offers: Claude first, then Gemini. */
export function modelChoices(available: readonly ListedModel[]): ModelChoice[] {
	return [...CLAUDE_CHOICES, ...geminiChoices(available)];
}

const FALLBACK: Readonly<Record<Effort, readonly Effort[]>> = {
	low: ["low", "medium", "high"],
	medium: ["medium", "high", "low"],
	high: ["high", "medium", "low"],
};

export function agyModelId(family: string, effort: Effort, available: readonly string[]): string | null {
	for (const level of FALLBACK[effort]) {
		const id = `${family}-${level}`;
		if (available.includes(id)) return id;
	}
	return null;
}

/**
 * The choice a chat's model belongs to, among `choices` (see `modelChoices`).
 * Undefined for a model no longer offered (an old setting, a Gemini Antigravity
 * has dropped): callers show its raw id.
 */
export function choiceOf(agent: AgentKind, model: string, choices: readonly ModelChoice[] = CLAUDE_CHOICES): ModelChoice | undefined {
	if (agent === "claude") return choices.find((c) => c.agent === "claude" && c.id === (model || "opus"));
	if (!model) return undefined;
	const family = geminiFamily(model);
	return choices.find((c) => c.agent === "agy" && c.id === family);
}

export function modelForChoice(choice: ModelChoice, effort: Effort, available: readonly string[]): string | null {
	return choice.agent === "claude" ? choice.id : agyModelId(choice.id, effort, available);
}

/** "opus" → "Opus 5.5", "gemini-3.8-flash-high" → "Gemini 3.8 Flash"; anything else as it came. */
export function modelLabelOf(model: string, choices: readonly ModelChoice[]): string {
	const choice = choices.find((c) => (c.agent === "claude" ? model === c.id : geminiFamily(model) === c.id));
	return choice?.label ?? model;
}

/** A select's options, plus the saved value as itself when it is no longer among them. */
export function withCurrentOption<T extends { readonly id: string; readonly label: string }>(
	options: readonly T[],
	current: string,
): readonly (T | { readonly id: string; readonly label: string })[] {
	return options.some((o) => o.id === current) ? options : [...options, { id: current, label: current }];
}

/**
 * The Gemini model to switch to when a chat's effort changes: the same family
 * at the new thinking level (or the nearest one Antigravity has). Null when
 * nothing changes: already that variant, a model without levels, or none listed.
 */
export function geminiAtEffort(model: string, effort: Effort, available: readonly string[]): string | null {
	if (!model.startsWith("gemini-")) return null;
	const id = agyModelId(geminiFamily(model), effort, available);
	return id && id !== model ? id : null;
}
