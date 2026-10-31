import { ipcMain, type BrowserWindow } from "electron";
import { checkForUpdatesNow, startUpdates, installUpdateNow, type UpdateStatus } from "../update/updater.ts";
import { checkReleaseAccess, isGithubToken } from "../update/update-config.ts";
import type { SecretStore } from "../settings/secrets.ts";

/**
 * Update status flows the same way chat events do: the main process watches,
 * the window displays. The last status is kept so a window opening late still
 * learns where things stand.
 *
 * The window can hand over a token once (it is checked against GitHub, then
 * stored encrypted) and learn whether one is saved — never read it back.
 */
export function registerUpdateIpc(getWindow: () => BrowserWindow | null, secrets: SecretStore): () => void {
	let latest: UpdateStatus = { state: "checking" };

	const report = (status: UpdateStatus): void => {
		latest = status;
		const window = getWindow();
		if (window && !window.isDestroyed()) {
			window.webContents.send("update:status", status);
		}
	};
	const start = (): (() => void) => startUpdates(report, () => secrets.get("update"));
	let stop = start();
	const restart = (): void => {
		stop();
		stop = start();
	};

	ipcMain.handle("update:status", () => latest);
	ipcMain.on("update:install", () => installUpdateNow());
	ipcMain.on("update:check", () => checkForUpdatesNow());
	ipcMain.handle("update:has-token", () => secrets.has("update"));
	ipcMain.handle("update:set-token", async (_event, token: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
		const value = typeof token === "string" ? token.trim() : "";
		if (!isGithubToken(value)) return { ok: false, message: "That does not look like a GitHub token." };
		const access = await checkReleaseAccess(value);
		if (!access.ok) return access;
		try {
			secrets.set("update", value);
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
		restart();
		return { ok: true };
	});
	ipcMain.handle("update:clear-token", () => {
		secrets.delete("update");
		restart();
	});

	return () => stop();
}
