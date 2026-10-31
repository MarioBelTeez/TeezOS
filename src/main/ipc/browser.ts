import { ipcMain, shell, type IpcMainEvent } from "electron";
import type { BrowserAction, BrowserManager } from "../browser/manager.ts";
import { isBrowserText as isText, isTabId, parseRect } from "../browser/validate.ts";

/**
 * The browser over IPC. The renderer names tabs and reports where the panel
 * is; it never hands the main process a scheme to open or a path to write.
 * Every argument is checked here, and only the app's own window is heard.
 */

const ACTIONS: readonly BrowserAction[] = ["back", "forward", "reload", "stop"];

export function registerBrowserIpc(manager: BrowserManager): () => void {
	/** Listens on a channel, but only to the app window. */
	const listen = (channel: string, handler: (...args: unknown[]) => void): void => {
		ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
			if (manager.isAppWindow(event.sender)) handler(...args);
		});
	};

	listen("browser:create", (tabId, url) => {
		if (isTabId(tabId) && isText(url)) manager.create(tabId, url);
	});
	listen("browser:navigate", (tabId, input) => {
		if (isTabId(tabId) && isText(input) && input.trim() !== "") manager.navigate(tabId, input);
	});
	listen("browser:action", (tabId, action) => {
		if (isTabId(tabId) && ACTIONS.includes(action as BrowserAction)) manager.action(tabId, action as BrowserAction);
	});
	listen("browser:bounds", (tabId, rect) => {
		const parsed = parseRect(rect);
		if (isTabId(tabId) && parsed !== undefined) manager.setBounds(tabId, parsed);
	});
	listen("browser:find", (tabId, text, forward) => {
		if (isTabId(tabId) && isText(text) && typeof forward === "boolean") manager.find(tabId, text, forward);
	});
	listen("browser:stop-find", (tabId) => {
		if (isTabId(tabId)) manager.stopFind(tabId);
	});
	listen("browser:zoom", (tabId, delta) => {
		if (isTabId(tabId) && (delta === -1 || delta === 0 || delta === 1)) manager.zoom(tabId, delta);
	});
	listen("browser:permission", (requestId, allow) => {
		if (isTabId(requestId) && typeof allow === "boolean") manager.answerPermission(requestId, allow);
	});
	listen("browser:download-answer", (id, save) => {
		if (isTabId(id) && typeof save === "boolean") manager.answerDownload(id, save);
	});
	listen("browser:close", (tabId) => {
		if (isTabId(tabId)) manager.close(tabId);
	});
	// The tab's own page, read here: the renderer cannot ask for an arbitrary URL to be opened.
	listen("browser:open-external", (tabId) => {
		if (!isTabId(tabId)) return;
		const url = manager.urlOf(tabId);
		if (url) void shell.openExternal(url);
	});

	ipcMain.handle("browser:clear-data", async (event): Promise<{ ok: true } | { ok: false; message: string }> => {
		if (!manager.isAppWindow(event.sender)) return { ok: false, message: "Not allowed." };
		try {
			await manager.clearData();
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	});

	return () => {
		ipcMain.removeHandler("browser:clear-data");
		for (const channel of [
			"browser:create",
			"browser:navigate",
			"browser:action",
			"browser:bounds",
			"browser:find",
			"browser:stop-find",
			"browser:zoom",
			"browser:permission",
			"browser:download-answer",
			"browser:close",
			"browser:open-external",
		]) {
			ipcMain.removeAllListeners(channel);
		}
	};
}
