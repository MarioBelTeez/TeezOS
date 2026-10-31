import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import type { SettingsStore, Workspace } from "../settings/store.ts";
import { resolveInsideReal } from "../workspace/guard.ts";
import {
	createEntry,
	deleteEntry,
	listDirectory,
	readWorkspaceFile,
	renameEntry,
	writeWorkspaceFile,
	type Failure,
} from "../workspace/files.ts";
import { readGitStatus, readHeadFile, readLog } from "../workspace/git.ts";
import { WorkspaceWatcher } from "../workspace/watcher.ts";
import { listAllFiles } from "../workspace/index.ts";
import { invalidateVault } from "../brain/vault.ts";
import { searchWorkspace } from "../workspace/search.ts";
import { commitPaths, pull, push } from "../workspace/git-write.ts";

/**
 * Workspaces, files and git over IPC.
 *
 * The renderer names a workspace by id and a file by a path relative to it;
 * the absolute folder never comes from the window. Every argument is checked
 * here, because the renderer is the untrusted side of this boundary.
 */

const isText = (value: unknown): value is string => typeof value === "string";

export function registerWorkspaceIpc(
	store: SettingsStore,
	getWindow: () => BrowserWindow | null,
	onUnpin: (workspaceId: string) => void,
): () => void {
	const watchers = new Map<string, WorkspaceWatcher>();

	const send = (channel: string, payload: unknown): void => {
		const window = getWindow();
		if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
	};

	const find = (id: unknown): Workspace | undefined =>
		isText(id) ? store.get().workspaces.find((w) => w.id === id) : undefined;

	const missing: Failure = { ok: false, reason: "That workspace is not pinned." };

	/** Watch every pinned folder, and only those. */
	const syncWatchers = (): void => {
		const pinned = new Map(store.get().workspaces.map((w) => [w.id, w]));
		for (const [id, watcher] of watchers) {
			if (!pinned.has(id) || pinned.get(id)?.path !== watcher.root) {
				watcher.close();
				watchers.delete(id);
			}
		}
		for (const workspace of pinned.values()) {
			if (watchers.has(workspace.id)) continue;
			watchers.set(
				workspace.id,
				new WorkspaceWatcher(workspace.path, (change) => {
					// Brain's index of the vault is cached; a change there must not be
					// answered from the cache by the refresh this event triggers.
					const vault = store.get().vaultPath;
					if (vault && change.dirs.length > 0 && vault.toLowerCase() === workspace.path.toLowerCase()) invalidateVault(vault);
					send("fs:changed", { workspaceId: workspace.id, ...change });
				}),
			);
		}
	};
	syncWatchers();
	const offSettings = store.onChange(syncWatchers);

	ipcMain.handle("workspace:pin-dialog", async () => {
		const window = getWindow();
		const options = { title: "Pin a folder", properties: ["openDirectory" as const] };
		const result = window
			? await dialog.showOpenDialog(window, options)
			: await dialog.showOpenDialog(options);
		const [folder] = result.filePaths;
		if (result.canceled || !folder) return null;
		try {
			return store.pin(folder);
		} catch {
			return null;
		}
	});

	ipcMain.handle("workspace:unpin", (_event, id: unknown) => {
		const workspace = find(id);
		if (!workspace) return;
		onUnpin(workspace.id);
		store.unpin(workspace.id);
	});

	ipcMain.handle("workspace:activate", (_event, id: unknown) => {
		if (isText(id)) store.setActive(id);
	});

	ipcMain.handle("workspace:reorder", (_event, ids: unknown) => {
		if (!Array.isArray(ids) || !ids.every(isText)) return;
		store.update((s) => {
			const byId = new Map(s.workspaces.map((w) => [w.id, w]));
			const ordered = ids.map((id) => byId.get(id)).filter((w): w is Workspace => !!w);
			const rest = s.workspaces.filter((w) => !ids.includes(w.id));
			return { ...s, workspaces: [...ordered, ...rest] };
		});
	});

	/** Show a file or folder in the system file manager. */
	ipcMain.handle("workspace:reveal", (_event, id: unknown, relative: unknown) => {
		const workspace = find(id);
		if (!workspace || !isText(relative)) return;
		const guarded = resolveInsideReal(workspace.path, relative);
		if (!guarded.ok) return;
		if (relative === "") void shell.openPath(guarded.path);
		else shell.showItemInFolder(guarded.path);
	});

	ipcMain.handle("files:list", (_event, id: unknown, relative: unknown) => {
		const workspace = find(id);
		if (!workspace || !isText(relative)) return missing;
		return listDirectory(workspace.path, relative);
	});

	ipcMain.handle("files:read", (_event, id: unknown, relative: unknown) => {
		const workspace = find(id);
		if (!workspace || !isText(relative)) return missing;
		return readWorkspaceFile(workspace.path, relative);
	});

	ipcMain.handle("files:write", (_event, id: unknown, relative: unknown, content: unknown) => {
		const workspace = find(id);
		if (!workspace || !isText(relative) || !isText(content)) return missing;
		return writeWorkspaceFile(workspace.path, relative, content);
	});

	ipcMain.handle("files:create", (_event, id: unknown, relative: unknown, kind: unknown) => {
		const workspace = find(id);
		if (!workspace || !isText(relative) || (kind !== "file" && kind !== "dir")) return missing;
		return createEntry(workspace.path, relative, kind);
	});

	ipcMain.handle("files:rename", (_event, id: unknown, from: unknown, to: unknown) => {
		const workspace = find(id);
		if (!workspace || !isText(from) || !isText(to)) return missing;
		return renameEntry(workspace.path, from, to);
	});

	/**
	 * Deleting asks in the main process, not the window: a compromised or
	 * buggy renderer cannot skip a dialog it does not draw.
	 */
	ipcMain.handle("files:delete", async (_event, id: unknown, relative: unknown) => {
		const workspace = find(id);
		if (!workspace || !isText(relative)) return missing;
		const window = getWindow();
		const options = {
			type: "warning" as const,
			buttons: ["Delete", "Cancel"],
			defaultId: 1,
			cancelId: 1,
			title: "Delete",
			message: `Delete "${relative}"?`,
			detail: `From ${workspace.name}. This cannot be undone from TeezOS.`,
		};
		const answer = window
			? await dialog.showMessageBox(window, options)
			: await dialog.showMessageBox(options);
		if (answer.response !== 0) return { ok: false, reason: "cancelled" };
		return deleteEntry(workspace.path, relative);
	});

	ipcMain.handle("files:index", (_event, id: unknown) => {
		const workspace = find(id);
		return workspace ? listAllFiles(workspace.path) : [];
	});

	ipcMain.handle("files:search", (_event, id: unknown, query: unknown, options: unknown) => {
		const workspace = find(id);
		if (!workspace || !isText(query) || query.length > 500) return [];
		const o = typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
		return searchWorkspace(workspace.path, query, {
			caseSensitive: o["caseSensitive"] === true,
			regex: o["regex"] === true,
		});
	});

	ipcMain.handle("git:commit", (_event, id: unknown, paths: unknown, message: unknown) => {
		const workspace = find(id);
		if (!workspace || !Array.isArray(paths) || !paths.every(isText) || !isText(message)) {
			return { ok: false, output: "Bad request." };
		}
		return commitPaths(workspace.path, paths, message);
	});

	ipcMain.handle("git:push", (_event, id: unknown) => {
		const workspace = find(id);
		return workspace ? push(workspace.path) : { ok: false, output: "That workspace is not pinned." };
	});

	ipcMain.handle("git:pull", (_event, id: unknown) => {
		const workspace = find(id);
		return workspace ? pull(workspace.path) : { ok: false, output: "That workspace is not pinned." };
	});

	ipcMain.handle("git:status", (_event, id: unknown) => {
		const workspace = find(id);
		return workspace ? readGitStatus(workspace.path) : null;
	});

	ipcMain.handle("git:head", (_event, id: unknown, relative: unknown) => {
		const workspace = find(id);
		if (!workspace || !isText(relative)) return null;
		if (!resolveInsideReal(workspace.path, relative).ok) return null;
		return readHeadFile(workspace.path, relative);
	});

	ipcMain.handle("git:log", (_event, id: unknown) => {
		const workspace = find(id);
		return workspace ? readLog(workspace.path) : [];
	});

	return () => {
		offSettings();
		for (const watcher of watchers.values()) watcher.close();
		watchers.clear();
	};
}
