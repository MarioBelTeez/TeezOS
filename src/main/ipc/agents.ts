import { ipcMain, shell } from "electron";
import { installProvider, loginProvider, readProviderStatuses, type ProviderId } from "../agents/setup.ts";

function asProvider(value: unknown): ProviderId | null {
	return value === "claude" || value === "codex" || value === "agy" ? value : null;
}

export function registerAgentsIpc(): void {
	ipcMain.handle("agents:setup-status", () => readProviderStatuses());
	ipcMain.handle("agents:setup-login", async (_event, id: unknown) => {
		const provider = asProvider(id);
		if (!provider) return { ok: false, error: "Unknown AI provider." };
		return loginProvider(provider);
	});
	ipcMain.handle("agents:setup-install", async (_event, id: unknown) => {
		const provider = asProvider(id);
		if (!provider) return { ok: false, error: "Unknown AI provider." };
		return installProvider(provider);
	});
	ipcMain.handle("agents:open-external", async (_event, url: unknown) => {
		if (typeof url === "string" && /^https:\/\//i.test(url)) {
			await shell.openExternal(url);
		}
	});
}
