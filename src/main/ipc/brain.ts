import path from "node:path";
import { ipcMain, shell } from "electron";
import type { SettingsStore } from "../settings/store.ts";
import { readNote, scanVault } from "../brain/vault.ts";
import { searchBrain } from "../brain/search.ts";
import { resolveInsideReal } from "../workspace/guard.ts";

/** Brain over IPC: the vault's index, one note, search, and "open in Obsidian". */
export function registerBrainIpc(store: SettingsStore): void {
	const vault = (): string | null => store.get().vaultPath;
	const isText = (value: unknown): value is string => typeof value === "string";

	ipcMain.handle("brain:index", async () => {
		const root = vault();
		if (!root) return null;
		return { root, ...(await scanVault(root)) };
	});

	ipcMain.handle("brain:note", (_event, relative: unknown) => {
		const root = vault();
		if (!root || !isText(relative)) return null;
		return readNote(root, relative);
	});

	ipcMain.handle("brain:search", (_event, query: unknown, deep: unknown) => {
		const root = vault();
		if (!root || !isText(query)) return { hits: [], engine: "none" };
		return searchBrain(root, query, deep === true);
	});

	/** Hand the note to Obsidian itself, for its graph, canvas and plugins. */
	ipcMain.handle("brain:open-in-obsidian", (_event, relative: unknown) => {
		const root = vault();
		if (!root || !isText(relative) || !resolveInsideReal(root, relative).ok) return;
		const vaultName = path.basename(root);
		void shell.openExternal(`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relative)}`);
	});
}
