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
	readonly load: () => Promise<void>;
};

export const useAgents = create<AgentsState>((set) => ({
	usage: null,
	setUsage: (usage) => set({ usage }),
	agyAvailable: false,
	agyModels: [],
	load: async () => {
		const status = await window.teez.agents.agyStatus();
		set({ agyAvailable: status.available, agyModels: status.models });
	},
}));

/**
 * Claude's choices plus the Gemini families Antigravity lists now. Derived
 * here rather than in a selector: a selector returning a fresh array on every
 * call makes zustand re-render forever (React #185).
 */
export function useModelChoices(): readonly ModelChoice[] {
	const agyModels = useAgents((s) => s.agyModels);
	return useMemo(() => modelChoices(agyModels), [agyModels]);
}

/** A model id as people read it: "Opus 5.5", "Gemini 3.8 Flash", or the id itself when unknown. */
export function useModelLabel(model: string): string {
	const choices = useModelChoices();
	return modelLabelOf(model, choices);
}
