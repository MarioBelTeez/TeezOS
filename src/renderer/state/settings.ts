import { create } from "zustand";
import type { AgentSettings, LayoutSettings, Settings } from "../../main/settings/store.ts";
import { mergeModules, type ModulesPatch } from "../../shared/modules.ts";
import type { Preset } from "../../shared/presets.ts";

/**
 * A mirror of the main process's settings. Layout changes apply at once and
 * are saved a moment later, so dragging a splitter does not write the file
 * sixty times a second.
 */

type SettingsState = {
	readonly settings: Settings | null;
	readonly load: () => Promise<void>;
	readonly setLayout: (patch: Partial<LayoutSettings>) => void;
	readonly setAgent: (patch: Partial<AgentSettings>) => void;
	readonly setModules: (patch: ModulesPatch) => void;
	readonly setPresets: (presets: readonly Preset[]) => void;
};

let pendingLayout: Partial<LayoutSettings> = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useSettings = create<SettingsState>((set, get) => ({
	settings: null,

	load: async () => {
		set({ settings: await window.teez.settings.get() });
		window.teez.settings.onChange((settings) => {
			// Keep any layout change still waiting to be saved.
			set({ settings: { ...settings, layout: { ...settings.layout, ...pendingLayout } } });
		});
	},

	setLayout: (patch) => {
		const current = get().settings;
		if (!current) return;
		set({ settings: { ...current, layout: { ...current.layout, ...patch } } });
		pendingLayout = { ...pendingLayout, ...patch };
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			const layout = pendingLayout;
			pendingLayout = {};
			saveTimer = null;
			void window.teez.settings.update({ layout });
		}, 400);
	},

	setAgent: (patch) => {
		const current = get().settings;
		if (!current) return;
		set({ settings: { ...current, agent: { ...current.agent, ...patch } } });
		void window.teez.settings.update({ agent: patch });
	},

	setModules: (patch) => {
		const current = get().settings;
		if (!current) return;
		set({ settings: { ...current, modules: mergeModules(current.modules, patch) } });
		void window.teez.settings.update({ modules: patch });
	},

	setPresets: (presets) => {
		const current = get().settings;
		if (!current) return;
		set({ settings: { ...current, presets } });
		void window.teez.settings.update({ presets });
	},
}));

/**
 * The project in front of you is the active desk's. The main process is told
 * too, but its answer arrives a moment later; the desk is never behind.
 */
export function activeWorkspaceIdOf(settings: Settings | null): string | null {
	if (!settings) return null;
	const desk = settings.layout.desks.find((d) => d.id === settings.layout.activeDeskId);
	const id = desk?.workspaceId || settings.activeWorkspaceId;
	return settings.workspaces.some((w) => w.id === id) ? (id ?? null) : settings.activeWorkspaceId;
}

/** The pinned workspace that is the vault (the Brain's folder), if it is pinned. */
export function vaultWorkspaceIdOf(settings: Settings | null): string | null {
	if (!settings?.vaultPath) return null;
	const target = settings.vaultPath.toLowerCase().replace(/[\\/]+$/, "");
	return settings.workspaces.find((w) => w.path.toLowerCase().replace(/[\\/]+$/, "") === target)?.id ?? null;
}

export function useActiveWorkspace() {
	return useSettings((state) => {
		const id = activeWorkspaceIdOf(state.settings);
		return state.settings?.workspaces.find((w) => w.id === id) ?? null;
	});
}
