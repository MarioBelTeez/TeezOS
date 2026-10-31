import { app, dialog, ipcMain, type BrowserWindow } from "electron";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { SettingsStore } from "../settings/store.ts";
import { findWorkspaceIcon, MAX_ICON_BYTES, type WorkspaceIcon } from "../workspace/icon.ts";

/**
 * Logos on the workspace tiles. The window asks for a folder's logo by id and
 * gets a data URL or null (initials); picking an image happens in a native
 * dialog here, and the copy lives in the app's data folder, never in the
 * project.
 */

const PICKABLE = ["svg", "png", "ico", "jpg", "jpeg", "webp", "gif"];

export function registerIconIpc(store: SettingsStore, getWindow: () => BrowserWindow | null): void {
	const dir = path.join(app.getPath("userData"), "workspace-icons");
	const find = (id: unknown) => (typeof id === "string" ? store.get().workspaces.find((w) => w.id === id) : undefined);

	const customFor = async (id: string): Promise<string | null> => {
		try {
			const name = (await readdir(dir)).find((file) => path.parse(file).name === id);
			return name ? path.join(dir, name) : null;
		} catch {
			return null;
		}
	};
	const removeCustom = async (id: string): Promise<void> => {
		for (let custom = await customFor(id); custom; custom = await customFor(id)) await rm(custom, { force: true });
	};
	const setMode = (id: string, initials: boolean): void => {
		store.update((s) => ({
			...s,
			workspaces: s.workspaces.map((w) => {
				if (w.id !== id) return w;
				const { icon: _icon, ...rest } = w;
				return initials ? { ...rest, icon: "initials" as const } : rest;
			}),
		}));
	};

	ipcMain.handle("workspace:icon", async (_event, id: unknown): Promise<WorkspaceIcon | null> => {
		const workspace = find(id);
		if (!workspace || workspace.icon === "initials") return null;
		return findWorkspaceIcon(workspace.path, await customFor(workspace.id));
	});

	ipcMain.handle("workspace:pick-icon", async (_event, id: unknown): Promise<{ ok: true } | { ok: false; reason: string }> => {
		const workspace = find(id);
		if (!workspace) return { ok: false, reason: "No such folder." };
		const window = getWindow();
		const options = { title: `Icon for ${workspace.name}`, properties: ["openFile" as const], filters: [{ name: "Images", extensions: PICKABLE }] };
		const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
		const file = picked.filePaths[0];
		if (picked.canceled || !file) return { ok: false, reason: "cancelled" };
		const ext = path.extname(file).toLowerCase().slice(1);
		if (!PICKABLE.includes(ext)) return { ok: false, reason: "Pick an SVG, PNG, ICO, JPEG, WebP or GIF." };
		if ((await stat(file)).size > MAX_ICON_BYTES) return { ok: false, reason: "That image is over 512 KB; pick a smaller one." };
		await mkdir(dir, { recursive: true });
		await removeCustom(workspace.id);
		await copyFile(file, path.join(dir, `${workspace.id}.${ext}`));
		setMode(workspace.id, false);
		return { ok: true };
	});

	/** "logo": the picked image or the folder's own; "initials": letters. Either way a picked image is forgotten. */
	ipcMain.handle("workspace:icon-mode", async (_event, id: unknown, mode: unknown) => {
		const workspace = find(id);
		if (!workspace || (mode !== "logo" && mode !== "initials")) return;
		await removeCustom(workspace.id);
		setMode(workspace.id, mode === "initials");
	});
}
