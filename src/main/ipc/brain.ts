import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import type { SettingsStore } from "../settings/store.ts";
import { createStarterBrain, personalizeStarterBrain } from "../brain/starter.ts";
import { invalidateVault, readNote, scanVault } from "../brain/vault.ts";
import { searchBrain } from "../brain/search.ts";
import { resolveInsideReal } from "../workspace/guard.ts";

/** Brain over IPC: the vault's index, one note, search, "open in Obsidian", and first-run Starter Brain setup. */
export function registerBrainIpc(
	store: SettingsStore,
	getWindow: () => BrowserWindow | null = () => null,
): void {
	const vault = (): string | null => store.get().vaultPath;
	const isText = (value: unknown): value is string => typeof value === "string";

	const bindVaultWorkspace = (folder: string) => {
		const workspace = store.pin(folder);
		store.update((s) => {
			const desks = s.layout.desks.map((d, idx) =>
				idx === 0 && (!d.workspaceId || !s.workspaces.some((w) => w.id === d.workspaceId))
					? { ...d, workspaceId: workspace.id }
					: d,
			);
			return {
				...s,
				vaultPath: workspace.path,
				activeWorkspaceId: workspace.id,
				layout: { ...s.layout, desks },
			};
		});
		invalidateVault(workspace.path);
		return workspace;
	};

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

	ipcMain.handle("brain:default-starter-path", () => {
		const target = path.join(homedir(), "TeezMind");
		return { path: target, exists: existsSync(target) };
	});

	ipcMain.handle("brain:pick-existing", async () => {
		const window = getWindow();
		const options = { title: "Select your existing Brain vault folder", properties: ["openDirectory" as const] };
		const result = window
			? await dialog.showOpenDialog(window, options)
			: await dialog.showOpenDialog(options);
		const [folder] = result.filePaths;
		if (result.canceled || !folder) return { ok: false as const, reason: "cancelled" };
		try {
			const workspace = bindVaultWorkspace(folder);
			return { ok: true as const, workspace };
		} catch (err) {
			return { ok: false as const, reason: err instanceof Error ? err.message : "Could not open folder." };
		}
	});

	ipcMain.handle("brain:pick-parent-dir", async () => {
		const window = getWindow();
		const options = { title: "Choose where to create your Starter Brain", properties: ["openDirectory" as const] };
		const result = window
			? await dialog.showOpenDialog(window, options)
			: await dialog.showOpenDialog(options);
		const [folder] = result.filePaths;
		if (result.canceled || !folder) return null;
		return path.basename(folder).toLowerCase() === "teezmind" ? folder : path.join(folder, "TeezMind");
	});

	ipcMain.handle("brain:create-starter", (_event, raw: unknown) => {
		const bag = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
		const targetDir = isText(bag["targetDir"]) && bag["targetDir"].trim() ? bag["targetDir"].trim() : path.join(homedir(), "TeezMind");
		const userName = isText(bag["userName"]) ? bag["userName"] : undefined;
		const goals = Array.isArray(bag["goals"]) ? bag["goals"].filter(isText) : undefined;
		const useCases = Array.isArray(bag["useCases"]) ? bag["useCases"].filter(isText) : undefined;

		const created = createStarterBrain({ targetDir, userName, goals, useCases });
		if (!created.ok) return created;
		try {
			const workspace = bindVaultWorkspace(created.path);
			return { ok: true as const, workspace, createdFiles: created.createdFiles };
		} catch (err) {
			return { ok: false as const, reason: err instanceof Error ? err.message : "Could not pin Starter Brain." };
		}
	});

	ipcMain.handle("brain:personalize-starter", (_event, raw: unknown) => {
		const root = vault();
		if (!root) return { ok: false, reason: "No Brain vault folder is configured." };
		const bag = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
		const userName = isText(bag["userName"]) ? bag["userName"] : undefined;
		const goals = Array.isArray(bag["goals"]) ? bag["goals"].filter(isText) : undefined;
		const useCases = Array.isArray(bag["useCases"]) ? bag["useCases"].filter(isText) : undefined;
		const result = personalizeStarterBrain(root, { userName, goals, useCases });
		if (result.ok) invalidateVault(root);
		return result;
	});
}
