import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { SettingsStore, firstRunWorkspaces } from "./settings/store.ts";
import { registerSettingsIpc } from "./ipc/settings.ts";
import { registerWorkspaceIpc } from "./ipc/workspace.ts";
import { registerChatIpc } from "./ipc/chat.ts";
import { registerBtwIpc } from "./ipc/btw.ts";
import { registerUpdateIpc } from "./ipc/update.ts";
import { registerTerminalIpc } from "./ipc/terminal.ts";
import { registerBrainIpc } from "./ipc/brain.ts";
import { registerServerIpc } from "./ipc/server.ts";
import { registerAutomationsIpc } from "./ipc/automations.ts";
import { SecretStore } from "./settings/secrets.ts";
import { loadWindowState, trackWindowState } from "./window-state.ts";
import { isNetworkFileUrl } from "./net-guard.ts";
import { registerIconIpc } from "./ipc/icons.ts";
import { startPresence, type Presence } from "./discord/start.ts";
import { PresenceTracker } from "./discord/presence.ts";
import { isCaptureMode, maybeCapture, prepareCaptureProfile } from "./dev-capture.ts";
import { LEGACY_LOGIN_ITEM, dataDirFor } from "./data-dir.ts";
import { BrowserManager } from "./browser/manager.ts";
import { registerBrowserIpc } from "./ipc/browser.ts";
import { registerFeedIpc } from "./ipc/feed.ts";

/** BelTeez `--bg`. Set on the window so startup never flashes white. */
const BACKGROUND = "#08060A";

/** Where a link clicked in the app goes: the built-in browser when it is on, else the system browser. */
type LinkRouting = { readonly inBrowser: () => boolean };

/** Longest link handed to the built-in browser (its IPC refuses longer); longer ones go to the system browser. */
const MAX_BROWSER_LINK = 2048;

function createWindow(links: LinkRouting): BrowserWindow {
	const stateFile = join(app.getPath("userData"), "window-state.json");
	// A dev capture keeps the window hidden at the default size and never saves its state.
	const capturing = isCaptureMode();
	const state = capturing ? { bounds: null, maximized: false } : loadWindowState(stateFile);
	const window = new BrowserWindow({
		width: state.bounds?.width ?? 1440,
		height: state.bounds?.height ?? 900,
		...(state.bounds ? { x: state.bounds.x, y: state.bounds.y } : {}),
		minWidth: 940,
		minHeight: 600,
		show: false,
		backgroundColor: BACKGROUND,
		frame: false,
		webPreferences: {
			// CommonJS on purpose: a sandboxed preload cannot be an ES module.
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// Hidden windows still paint, so a capture is never blank.
			...(capturing ? { backgroundThrottling: false, paintWhenInitiallyHidden: true } : {}),
		},
	});

	if (capturing) {
		maybeCapture(window);
	} else {
		window.once("ready-to-show", () => {
			if (state.maximized) window.maximize();
			window.show();
		});
		trackWindowState(window, stateFile);
	}

	// Windows delivers the mouse side buttons as app-commands; the renderer works out which panel the pointer is over.
	window.on("app-command", (_event, command) => {
		if (command !== "browser-backward" && command !== "browser-forward") return;
		const point = screen.getCursorScreenPoint();
		const content = window.getContentBounds();
		window.webContents.send("nav:command", {
			direction: command === "browser-backward" ? "back" : "forward",
			x: point.x - content.x,
			y: point.y - content.y,
		});
	});

	// Unsaved editor tabs (counted by the window) hold the close until confirmed.
	let allowClose = false;
	window.on("close", (event) => {
		if (allowClose || unsavedFiles === 0) return;
		event.preventDefault();
		const answer = dialog.showMessageBoxSync(window, {
			type: "warning",
			buttons: ["Discard and close", "Cancel"],
			defaultId: 1,
			cancelId: 1,
			title: "TeezOS",
			message: `${unsavedFiles} file${unsavedFiles === 1 ? " has" : "s have"} unsaved changes.`,
			detail: "Closing now loses them.",
		});
		if (answer === 0) {
			allowClose = true;
			window.close();
		}
	});

	// Links in chat and notes open in a browser, never inside the app window:
	// the window holds the bridge, and a page loaded into it would hold it too.
	// The built-in browser panel takes them when it is on; Shift+click
	// ("new-window") always goes to the system browser.
	window.webContents.setWindowOpenHandler(({ url, disposition }) => {
		if (/^https?:\/\//i.test(url)) {
			if (disposition !== "new-window" && url.length <= MAX_BROWSER_LINK && links.inBrowser()) {
				window.webContents.send("browser:open-request", { url });
			} else {
				void shell.openExternal(url);
			}
		}
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		if (url !== window.webContents.getURL()) {
			event.preventDefault();
			if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
		}
	});

	// A Markdown image or link like "//host/x.png" resolves against this file://
	// page to a network path; refuse those whatever asks for them.
	window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
		callback({ cancel: isNetworkFileUrl(details.url) });
	});

	const devServer = process.env["ELECTRON_RENDERER_URL"];
	if (devServer) {
		void window.loadURL(devServer);
	} else {
		void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
	}

	return window;
}

/** How many editor tabs have unsaved changes, as the window last reported. */
let unsavedFiles = 0;

/** Window controls, because the frame is ours to draw. */
function registerWindowControls(): void {
	ipcMain.on("editor:unsaved", (_event, count: unknown) => {
		if (typeof count === "number" && Number.isInteger(count) && count >= 0) unsavedFiles = count;
	});
	ipcMain.handle("app:login-item", (_event, enable: unknown) => {
		// Packaged builds only: a dev run would register electron.exe itself.
		if (typeof enable === "boolean" && app.isPackaged) app.setLoginItemSettings({ openAtLogin: enable });
		return app.isPackaged ? app.getLoginItemSettings().openAtLogin : null;
	});
	ipcMain.handle("app:info", () => ({
		version: app.getVersion(),
		electron: process.versions.electron,
		platform: process.platform,
		userData: app.getPath("userData"),
	}));
	// The right-click menu's Paste: a real paste, so the page's paste handlers
	// (images into the chat) run as they do for Ctrl+V.
	ipcMain.on("edit:paste", (event) => event.sender.paste());
	ipcMain.on("window:minimize", (event) =>
		BrowserWindow.fromWebContents(event.sender)?.minimize(),
	);
	ipcMain.on("window:toggle-maximize", (event) => {
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) return;
		if (window.isMaximized()) window.unmaximize();
		else window.maximize();
	});
	ipcMain.on("window:close", (event) =>
		BrowserWindow.fromWebContents(event.sender)?.close(),
	);
}

// Opt-in DevTools protocol, for inspecting the live window from a script:
// TEEZAI_DEBUG_PORT=9222 npm run dev. Off unless asked for, so a normal run
// never exposes a debugging socket; never in a packaged build, where an
// inherited environment variable must not open one.
const debugPort = process.env["TEEZAI_DEBUG_PORT"];
if (debugPort && /^\d+$/.test(debugPort) && !app.isPackaged) {
	app.commandLine.appendSwitch("remote-debugging-port", debugPort);
}

// Renamed TeezAI → TeezOS in 0.3.8: stay on the data folder the app already has.
// Before the capture profile (which copies from it) and before ready.
app.setPath("userData", dataDirFor(app.getPath("appData"), (path) => existsSync(path)));

// Capture mode works on a temp copy of the settings; this has to happen before ready.
prepareCaptureProfile();

/**
 * Start-at-login set under the old name points at TeezAI.exe, which the
 * update removed: move it to this app. Packaged Windows builds only.
 */
function moveLegacyLoginItem(): void {
	if (!app.isPackaged || process.platform !== "win32") return;
	try {
		const old = app.getLoginItemSettings().launchItems?.find((item) => item.name === LEGACY_LOGIN_ITEM);
		if (!old) return;
		app.setLoginItemSettings({ openAtLogin: false, name: LEGACY_LOGIN_ITEM });
		// Turned off in Task Manager: the stale entry goes, nothing is turned back on.
		if (old.enabled !== false) app.setLoginItemSettings({ openAtLogin: true });
	} catch {
		// Not worth failing a start over; Settings → General can turn it on again.
	}
}

function isDirectory(folder: string): boolean {
	try {
		return statSync(folder).isDirectory();
	} catch {
		return false;
	}
}

function openSettings(): SettingsStore {
	const store = new SettingsStore(join(app.getPath("userData"), "settings.json"), () =>
		firstRunWorkspaces({ home: homedir(), platform: process.platform, isDirectory }),
	);

	// TEEZAI_WORKSPACE=<folder> pins that folder and opens it, for scripts and tests.
	const override = process.env["TEEZAI_WORKSPACE"];
	if (override && isDirectory(override)) store.pin(override);

	// Brain reads the vault; default it to the pinned TeezMind or ~/TeezMind.
	if (!store.get().vaultPath) {
		const pinned = store.get().workspaces.find((w) => w.name.toLowerCase() === "teezmind");
		const fallback = join(homedir(), "TeezMind");
		const vaultPath = pinned?.path ?? (isDirectory(fallback) ? fallback : null);
		if (vaultPath) store.update((s) => ({ ...s, vaultPath }));
	}
	return store;
}

void app.whenReady().then(() => {
	moveLegacyLoginItem();
	registerWindowControls();
	const store = openSettings();
	const links: LinkRouting = { inBrowser: () => store.get().modules.browser.enabled };
	let mainWindow = createWindow(links);
	const currentWindow = (): BrowserWindow | null =>
		mainWindow.isDestroyed() ? null : mainWindow;

	const stopSettings = registerSettingsIpc(store, currentWindow);
	// A capture run never shows on Discord.
	const presence: Presence = isCaptureMode() ? { tracker: new PresenceTracker(), changed: () => {}, stop: () => {} } : startPresence(store);
	const chats = registerChatIpc(store, currentWindow, {}, presence);
	const stopBtw = registerBtwIpc(store, chats, currentWindow);
	const terminals = registerTerminalIpc(store, currentWindow);
	registerBrainIpc(store);
	const secrets = new SecretStore(join(app.getPath("userData"), "secrets.json"));
	const stopServer = registerServerIpc(store, secrets, currentWindow);
	const stopAutomations = registerAutomationsIpc(store, secrets, currentWindow);
	const stopFeed = registerFeedIpc(store, secrets, currentWindow, join(app.getPath("userData"), "feed.json"), join(app.getPath("userData"), "feed-prefs.json"));
	const stopWorkspaces = registerWorkspaceIpc(store, currentWindow, (workspaceId) => {
		chats.closeWorkspace(workspaceId);
		if (presence.tracker.prune((chatId) => chats.has(chatId))) presence.changed();
		terminals.killWorkspace(workspaceId);
	});
	const stopUpdates = registerUpdateIpc(currentWindow, secrets);
	registerIconIpc(store, currentWindow);
	const browser = new BrowserManager(
		currentWindow,
		(channel, payload) => currentWindow()?.webContents.send(channel, payload),
		app.getPath("downloads"),
	);
	const stopBrowser = registerBrowserIpc(browser);
	// The browser module turned off: its pages close, they do not keep running hidden.
	const offBrowserModule = store.onChange((settings) => {
		if (!settings.modules.browser.enabled) browser.disposeAll();
	});
	app.on("will-quit", () => {
		stopUpdates();
		stopWorkspaces();
		stopSettings();
		stopBtw();
		chats.disposeAll();
		terminals.disposeAll();
		stopServer();
		stopAutomations();
		stopFeed();
		presence.stop();
		offBrowserModule();
		browser.disposeAll();
		stopBrowser();
	});

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(links);
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
