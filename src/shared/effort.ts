import type { AgentKind } from "../main/settings/store.ts";

/**
 * How hard the agent thinks, per chat, beside the model and mode pickers.
 * Claude takes Claude Code's levels ("" sends none: the model's own default);
 * Claude Code runs a level the model lacks at the nearest one it has (Max
 * becomes High on a model without Max). Antigravity has three, which pick the
 * Gemini model's thinking variant and go to `agy --effort`.
 */

export const CLAUDE_EFFORTS = ["", "low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export const AGY_EFFORTS = ["low", "medium", "high"] as const;
export type AgyEffort = (typeof AGY_EFFORTS)[number];

export type EffortOption = { readonly id: string; readonly label: string; readonly hint: string };

export const CLAUDE_EFFORT_OPTIONS: readonly EffortOption[] = [
	{ id: "", label: "Default", hint: "The model's own default" },
	{ id: "low", label: "Low", hint: "Fastest, fewest tokens" },
	{ id: "medium", label: "Medium", hint: "Balanced" },
	{ id: "high", label: "High", hint: "Thinks harder" },
	{ id: "xhigh", label: "Extra high", hint: "Harder still" },
	{ id: "max", label: "Max", hint: "Everything it has; uses the most of your limits" },
];

export const AGY_EFFORT_OPTIONS: readonly EffortOption[] = [
	{ id: "low", label: "Low", hint: "Fastest" },
	{ id: "medium", label: "Medium", hint: "Balanced" },
	{ id: "high", label: "High", hint: "Thinks harder" },
];

export function effortOptions(agent: AgentKind): readonly EffortOption[] {
	return agent === "claude" ? CLAUDE_EFFORT_OPTIONS : AGY_EFFORT_OPTIONS;
}

export function isEffort(agent: AgentKind, value: unknown): value is string {
	return typeof value === "string" && (agent === "claude" ? (CLAUDE_EFFORTS as readonly string[]) : (AGY_EFFORTS as readonly string[])).includes(value);
}

export function effortLabel(agent: AgentKind, effort: string): string {
	return effortOptions(agent).find((o) => o.id === effort)?.label ?? (effort || "Default");
}
