import { useMemo } from "react";
import { create } from "zustand";
import { modelChoices, modelLabelOf, type ModelChoice } from "../../shared/models.ts";

/**
 * What the agents on this machine can do: whether Antigravity is installed
 * and which models it offers. Claude's models are the fixed aliases its CLI
 * accepts, so they need no lookup.
 */

export type AgyModel = { readonly id: string; readonly label: string };

export type Usage = {
	readonly status: string;
	readonly window: string;
	readonly resetsAt: number;
	readonly seenAt: number;
};

type AgentsState = {
	readonly usage: Usage | null;
	readonly setUsage: (usage: Usage) => void;
	readonly agyAvailable: boolean;
	readonly agyModels: readonly AgyModel[];
	readonly codexAvailable: boolean;
	/** Why Codex can't run, when it can't (shown in Settings and on a Codex chat's card). */
	readonly codexReason: "codex-not-found" | "codex-logged-out" | "codex-unsupported" | null;
	readonly codexModels: readonly AgyModel[];
	readonly load: () => Promise<void>;
};

export const useAgents = create<AgentsState>((set) => ({
	usage: null,
	setUsage: (usage) => set({ usage }),
	agyAvailable: false,
	agyModels: [],
	codexAvailable: false,
	codexReason: null,
	codexModels: [],
	load: async () => {
		const [agy, codex] = await Promise.all([
			window.teez.agents.agyStatus(),
			window.teez.agents.codexStatus().catch(() => ({ available: false, reason: "codex-not-found" as const, models: [] })),
		]);
		set({
			agyAvailable: agy.available,
			agyModels: agy.models,
			codexAvailable: codex.available,
			codexReason: codex.available ? null : (codex.reason ?? "codex-not-found"),
			codexModels: codex.models,
		});
	},
}));

/**
 * Claude's choices plus the Gemini families Antigravity lists now. Derived
 * here rather than in a selector: a selector returning a fresh array on every
 * call makes zustand re-render forever (React #185).
 */
export function useModelChoices(): readonly ModelChoice[] {
	const agyModels = useAgents((s) => s.agyModels);
	const codexModels = useAgents((s) => s.codexModels);
	return useMemo(() => modelChoices(agyModels, codexModels), [agyModels, codexModels]);
}

/** A model id as people read it: "Opus 5.5", "Gemini 3.8 Flash", or the id itself when unknown. */
export function useModelLabel(model: string): string {
	const choices = useModelChoices();
	return modelLabelOf(model, choices);
}
