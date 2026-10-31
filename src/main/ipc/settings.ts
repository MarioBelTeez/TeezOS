import { ipcMain, type BrowserWindow } from "electron";
import type { Settings, SettingsStore } from "../settings/store.ts";
import { mergeModules } from "../../shared/modules.ts";

/**
 * The window may change how things look and which agent is the default —
 * nothing else. Workspaces change through pin/unpin, and connection details
 * through their own calls, so a renderer cannot point TeezAI at a different
 * server by rewriting its settings.
 */
export function registerSettingsIpc(
	store: SettingsStore,
	getWindow: () => BrowserWindow | null,
): () => void {
	ipcMain.handle("settings:get", () => store.get());

	ipcMain.handle("settings:update", (_event, patch: unknown) => {
		if (typeof patch !== "object" || patch === null) return store.get();
		const p = patch as Record<string, unknown>;
		return store.update((current): Settings => {
			const next = { ...current } as Record<string, unknown>;
			if (typeof p["layout"] === "object" && p["layout"] !== null) {
				next["layout"] = { ...current.layout, ...(p["layout"] as object) };
			}
			if (typeof p["agent"] === "object" && p["agent"] !== null) {
				next["agent"] = { ...current.agent, ...(p["agent"] as object) };
			}
			if (typeof p["modules"] === "object" && p["modules"] !== null) {
				next["modules"] = mergeModules(current.modules, p["modules"]);
			}
			if (Array.isArray(p["presets"])) next["presets"] = p["presets"];
			// The store normalizes: unknown keys and bad values fall away there.
			return next as Settings;
		});
	});

	return store.onChange((settings) => {
		const window = getWindow();
		if (window && !window.isDestroyed()) window.webContents.send("settings:changed", settings);
	});
}
