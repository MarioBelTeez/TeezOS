import { create } from "zustand";

/** Workspace logos by workspace id: a data URL, or null for initials. */

type IconsState = {
	readonly byId: Readonly<Record<string, string | null>>;
	readonly load: (ids: readonly string[]) => Promise<void>;
	readonly refresh: (id: string) => Promise<void>;
};

export const useWorkspaceIcons = create<IconsState>((set, get) => ({
	byId: {},
	load: async (ids) => {
		const entries = await Promise.all(
			ids.map(async (id) => [id, (await window.teez.workspaces.icon(id).catch(() => null))?.dataUrl ?? null] as const),
		);
		set({ byId: Object.fromEntries(entries) });
	},
	refresh: async (id) => {
		const icon = await window.teez.workspaces.icon(id).catch(() => null);
		set({ byId: { ...get().byId, [id]: icon?.dataUrl ?? null } });
	},
}));
