import { constants as fsConstants, existsSync, mkdirSync, rmSync } from "node:fs";
import { copyFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	Menu,
	WebContentsView,
	app,
	clipboard,
	session,
	shell,
	type BrowserWindow,
	type ContextMenuParams,
	type DownloadItem,
	type Input,
	type MenuItemConstructorOptions,
	type Session,
	type WebContents,
} from "electron";
import { SEARCH_URL, isAllowedUrl, toUrl } from "./url.ts";
import { decidePermission, originOf } from "./permissions.ts";
import { DOWNLOAD_CONFIRM_MS, downloadGate, formatBytes, safeFileName, uniquePath, zoneIdentifier, type DownloadGate } from "./downloads.ts";
import { startsNewDocument } from "./lifecycle.ts";
import { MAX_BROWSER_TABS } from "../../shared/modules.ts";
import type { Rect } from "./validate.ts";
import { fetchIcon } from "./favicon.ts";

export type { Rect };

/**
 * The built-in browser: one WebContentsView per tab, drawn by the main
 * process over the rectangle the Browser panel reports. Pages are untrusted:
 * they run sandboxed in their own persistent session (logins survive a
 * restart, separate from the app), with no preload and no Node, may only go
 * to http(s) pages, open popups as tabs (never windows), and ask before
 * using the camera, microphone, notifications or location.
 */

export const BROWSER_PARTITION = "persist:browser";

export type BrowserAction = "back" | "forward" | "reload" | "stop";

export type BrowserTabState = {
	readonly tabId: string;
	readonly url: string;
	readonly title: string;
	readonly loading: boolean;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly favicon: string | null;
	/** Percent. */
	readonly zoom: number;
};
export type BrowserPermissionRequest = { readonly requestId: string; readonly tabId: string; readonly origin: string; readonly permission: string };
export type BrowserDownload = { readonly name: string; readonly state: "progress" | "done" | "failed"; readonly path: string; readonly reason?: string };
/** A download waiting for Save or Cancel in its tab's panel; `size` is already formatted. */
export type BrowserDownloadAsk = { readonly id: string; readonly tabId: string; readonly name: string; readonly size: string; readonly host: string };
/** A tab the main process would not open (too many, or no window): the strip drops it. */
export type BrowserRefused = { readonly tabId: string };
export type BrowserFound = { readonly tabId: string; readonly matches: number; readonly active: number };
/** Keys pressed inside a page that belong to the browser's chrome. */
export type BrowserShortcut = { readonly tabId: string; readonly action: "find" | "address" | "escape" | "new-tab" | "close-tab" };
/** App shortcuts (palette, desks, views) pressed while a page has the focus. */
export type BrowserForwardedKey = { readonly key: string; readonly ctrl: boolean; readonly shift: boolean; readonly alt: boolean };

/** An unanswered permission prompt is a "no". */
const PERMISSION_TIMEOUT_MS = 120_000;
/** At most this many popups per page in this many milliseconds. */
const MAX_POPUPS = 3;
const POPUP_WINDOW_MS = 5000;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

type Tab = { readonly view: WebContentsView; readonly contentsId: number; favicon: string | null; faviconSource: string | null; lastFind: string | null; popups: number[] };
type PendingDownload = {
	readonly id: string;
	readonly tabId: string;
	readonly name: string;
	readonly item: DownloadItem;
	readonly url: string;
	/** Where it is written until the answer: a folder of its own under the system temp folder. */
	readonly temp: string;
	answer: "waiting" | "save" | "cancel";
	finished: "completed" | "failed" | null;
	readonly timer: ReturnType<typeof setTimeout>;
};
type Pending = { readonly tabId: string; readonly origin: string; readonly permission: string; readonly callbacks: ((allow: boolean) => void)[]; readonly timer: ReturnType<typeof setTimeout> };

/** The app's shortcuts a page should not swallow (see App.tsx). Ctrl+B/J/S stay the page's (webmail uses them); Ctrl+W closes the browser tab (see onKey). */
function isAppShortcut(input: Input, ctrl: boolean): boolean {
	const key = input.key.toLowerCase();
	if (ctrl) return ["k", "p", "`", ",", "tab", "1", "2", "3", "4", "5", "6", "7"].includes(key);
	return input.alt && /^[1-9]$/.test(key);
}

export class BrowserManager {
	private readonly getWindow: () => BrowserWindow | null;
	private readonly emit: (channel: string, payload: unknown) => void;
	private readonly downloadsDir: string;
	private readonly tabs = new Map<string, Tab>();
	/** webContents id → tab id, for session-wide handlers that only get the WebContents. */
	private readonly byContents = new Map<number, string>();
	/** Origin → permissions allowed this run. */
	private readonly grants = new Map<string, Set<string>>();
	private readonly pending = new Map<string, Pending>();
	/** Download paths being written, so two downloads of one name never share a file. */
	private readonly reserved = new Set<string>();
	/** Downloads waiting for an answer, or being finished. */
	private readonly downloads = new Map<string, PendingDownload>();
	private readonly pendingDir = join(tmpdir(), "teezai-downloads");
	private nextDownload = 0;
	private readonly watchedWindows = new WeakSet<BrowserWindow>();
	private browserSession: Session | null = null;
	private nextRequest = 0;

	constructor(getWindow: () => BrowserWindow | null, emit: (channel: string, payload: unknown) => void, downloadsDir: string) {
		this.getWindow = getWindow;
		this.emit = emit;
		this.downloadsDir = downloadsDir;
	}

	/** Whether an IPC message came from the app's own window (pages have no bridge, but check anyway). */
	isAppWindow(sender: WebContents): boolean {
		const window = this.getWindow();
		return !!window && !window.isDestroyed() && window.webContents.id === sender.id;
	}

	create(tabId: string, url: string): void {
		if (this.tabs.has(tabId)) return;
		const window = this.getWindow();
		// The renderer keeps to the same limit; if it ever disagrees, it is told so and drops the tab.
		if (this.tabs.size >= MAX_BROWSER_TABS || !window || window.isDestroyed()) {
			this.emit("browser:refused", { tabId } satisfies BrowserRefused);
			return;
		}
		this.ensureSession();
		const view = new WebContentsView({
			webPreferences: {
				partition: BROWSER_PARTITION,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webSecurity: true,
				spellcheck: true,
				// A page cannot lock the app up with an endless run of alert() dialogs.
				safeDialogs: true,
			},
		});
		view.setVisible(false);
		const tab: Tab = { view, contentsId: view.webContents.id, favicon: null, faviconSource: null, lastFind: null, popups: [] };
		this.tabs.set(tabId, tab);
		this.byContents.set(view.webContents.id, tabId);
		window.contentView.addChildView(view);
		this.watchWindow(window);
		this.wire(tabId, tab);
		this.load(tab, url);
	}

	navigate(tabId: string, input: string): void {
		const tab = this.tabs.get(tabId);
		if (tab) this.load(tab, input);
	}

	action(tabId: string, action: BrowserAction): void {
		const contents = this.tabs.get(tabId)?.view.webContents;
		if (!contents || contents.isDestroyed()) return;
		if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
		else if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
		else if (action === "reload") contents.reload();
		else if (action === "stop") contents.stop();
	}

	/** Null hides the tab (panel hidden, or something drawn over it); a rect shows it there and hides the others. */
	setBounds(tabId: string, rect: Rect | null): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		if (rect === null) {
			this.hide(tab);
			return;
		}
		for (const [id, other] of this.tabs) if (id !== tabId) this.hide(other);
		// The renderer measures in CSS pixels; the view is placed in window pixels.
		const window = this.getWindow();
		const scale = window && !window.isDestroyed() ? window.webContents.getZoomFactor() : 1;
		tab.view.setBounds({
			x: Math.round(rect.x * scale),
			y: Math.round(rect.y * scale),
			width: Math.round(rect.width * scale),
			height: Math.round(rect.height * scale),
		});
		tab.view.setVisible(true);
	}

	find(tabId: string, text: string, forward: boolean): void {
		const tab = this.tabs.get(tabId);
		if (!tab || tab.view.webContents.isDestroyed()) return;
		if (text === "") {
			this.stopFind(tabId);
			return;
		}
		// A new text starts a new search; the same text again moves to the next match.
		tab.view.webContents.findInPage(text, { forward, findNext: text !== tab.lastFind });
		tab.lastFind = text;
	}

	stopFind(tabId: string): void {
		const tab = this.tabs.get(tabId);
		if (!tab || tab.view.webContents.isDestroyed()) return;
		tab.view.webContents.stopFindInPage("clearSelection");
		tab.lastFind = null;
	}

	zoom(tabId: string, delta: -1 | 0 | 1): void {
		const tab = this.tabs.get(tabId);
		if (!tab || tab.view.webContents.isDestroyed()) return;
		const contents = tab.view.webContents;
		const current = contents.getZoomFactor();
		let next = 1;
		if (delta === 1) next = ZOOM_STEPS.find((step) => step > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 1;
		if (delta === -1) next = [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? ZOOM_STEPS[0] ?? 1;
		contents.setZoomFactor(next);
		this.emitState(tabId);
	}

	answerPermission(requestId: string, allow: boolean): void {
		const request = this.pending.get(requestId);
		if (!request) return;
		if (allow) {
			const granted = this.grants.get(request.origin) ?? new Set<string>();
			granted.add(request.permission);
			this.grants.set(request.origin, granted);
		}
		this.settle(requestId, allow);
	}

	/** The tab's page, for "Open in system browser"; null for the empty page or a tab that is gone. */
	urlOf(tabId: string): string | null {
		const contents = this.tabs.get(tabId)?.view.webContents;
		if (!contents || contents.isDestroyed()) return null;
		const url = contents.getURL();
		return url !== "about:blank" && isAllowedUrl(url) ? url : null;
	}

	close(tabId: string): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		for (const [requestId, request] of this.pending) if (request.tabId === tabId) this.settle(requestId, false);
		// A question nobody can answer any more is a "no".
		for (const [id, download] of this.downloads) if (download.tabId === tabId) this.answerDownload(id, false);
		this.tabs.delete(tabId);
		const contents = tab.view.webContents;
		this.byContents.delete(tab.contentsId);
		const window = this.getWindow();
		if (window && !window.isDestroyed()) window.contentView.removeChildView(tab.view);
		if (!contents.isDestroyed()) contents.close();
	}

	disposeAll(): void {
		for (const tabId of [...this.tabs.keys()]) this.close(tabId);
		for (const requestId of [...this.pending.keys()]) this.settle(requestId, false);
	}

	/** Settings → Browser: cookies, storage, cache and saved logins of the browser's own session. The app's session is untouched. */
	async clearData(): Promise<void> {
		const ses = session.fromPartition(BROWSER_PARTITION);
		await ses.clearStorageData();
		await ses.clearCache();
		await ses.clearAuthCache();
		for (const tab of this.tabs.values()) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
	}

	// ---------- inside ----------

	private load(tab: Tab, input: string): void {
		const contents = tab.view.webContents;
		if (contents.isDestroyed()) return;
		let target = toUrl(input);
		// "https://" with no host and the like: searched, never loaded.
		if (!isAllowedUrl(target)) target = `${SEARCH_URL}${encodeURIComponent(input.trim())}`;
		// A failed load (offline, refused) shows as the tab's title; nothing else to do with it.
		contents.loadURL(target).catch(() => {});
	}

	private hide(tab: Tab): void {
		if (!tab.view.getVisible()) return;
		const hadFocus = !tab.view.webContents.isDestroyed() && tab.view.webContents.isFocused();
		tab.view.setVisible(false);
		// Keys go back to the app, e.g. into the palette that just covered the page.
		const window = this.getWindow();
		if (hadFocus && window && !window.isDestroyed()) window.webContents.focus();
	}

	private watchWindow(window: BrowserWindow): void {
		if (this.watchedWindows.has(window)) return;
		this.watchedWindows.add(window);
		// The views belong to this window; when it goes, so do they.
		window.once("closed", () => this.disposeAll());
		// A reload of the app's page (Ctrl+R from the default menu, a dev reload) empties its tab list:
		// close the pages too, or they stay drawn over the new UI and keep running unseen.
		window.webContents.on("did-start-navigation", (details) => {
			if (startsNewDocument(details)) this.disposeAll();
		});
	}

	private emitState(tabId: string): void {
		const tab = this.tabs.get(tabId);
		if (!tab || tab.view.webContents.isDestroyed()) return;
		const contents = tab.view.webContents;
		const state: BrowserTabState = {
			tabId,
			url: contents.getURL(),
			title: contents.getTitle(),
			loading: contents.isLoading(),
			canGoBack: contents.navigationHistory.canGoBack(),
			canGoForward: contents.navigationHistory.canGoForward(),
			favicon: tab.favicon,
			zoom: Math.round(contents.getZoomFactor() * 100),
		};
		this.emit("browser:state", state);
	}

	private openAsTab(url: string): void {
		if (url !== "about:blank" && isAllowedUrl(url) && url.length <= 2048) this.emit("browser:open-tab", { url });
	}

	/** A page's own popups, a few at a time: a page cannot fill the strip with tabs. */
	private popupAllowed(tab: Tab): boolean {
		const now = Date.now();
		tab.popups = tab.popups.filter((at) => now - at < POPUP_WINDOW_MS);
		if (tab.popups.length >= MAX_POPUPS) return false;
		tab.popups.push(now);
		return true;
	}

	private wire(tabId: string, tab: Tab): void {
		const contents = tab.view.webContents;
		const state = (): void => this.emitState(tabId);

		// Only web pages: no file:, javascript:, or another app's scheme, by link, script or redirect.
		contents.on("will-navigate", (event) => {
			if (!isAllowedUrl(event.url)) event.preventDefault();
		});
		contents.on("will-redirect", (event) => {
			if (!isAllowedUrl(event.url)) event.preventDefault();
		});
		// Popups and target=_blank become tabs; a page never opens a window of its own.
		contents.setWindowOpenHandler(({ url }) => {
			if (this.popupAllowed(tab)) this.openAsTab(url);
			return { action: "deny" };
		});

		contents.on("did-start-loading", state);
		contents.on("did-stop-loading", state);
		contents.on("page-title-updated", state);
		contents.on("did-navigate", () => {
			tab.favicon = null;
			tab.faviconSource = null;
			state();
		});
		contents.on("did-navigate-in-page", state);
		contents.on("page-favicon-updated", (_event, favicons) => {
			const source = favicons[0];
			if (!source || source === tab.faviconSource) return;
			tab.faviconSource = source;
			const ses = contents.session;
			void fetchIcon(source, (url, init) => ses.fetch(url, init)).then((icon) => {
				// The page may have moved on, or the tab closed, while the icon loaded.
				if (tab.faviconSource !== source || !this.tabs.has(tabId)) return;
				tab.favicon = icon;
				state();
			});
		});
		contents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
			// -3 is an aborted load: the user went somewhere else.
			if (!isMainFrame || errorCode === -3) return;
			const current = this.tabs.get(tabId);
			if (!current || contents.isDestroyed()) return;
			this.emit("browser:state", {
				tabId,
				url: contents.getURL(),
				title: `Could not load: ${errorDescription}`,
				loading: false,
				canGoBack: contents.navigationHistory.canGoBack(),
				canGoForward: contents.navigationHistory.canGoForward(),
				favicon: null,
				zoom: Math.round(contents.getZoomFactor() * 100),
			} satisfies BrowserTabState);
		});
		contents.on("render-process-gone", () => {
			this.emit("browser:state", {
				tabId,
				url: "",
				title: "This page crashed. Reload it.",
				loading: false,
				canGoBack: false,
				canGoForward: false,
				favicon: null,
				zoom: 100,
			} satisfies BrowserTabState);
		});
		contents.on("found-in-page", (_event, result) => {
			this.emit("browser:found", { tabId, matches: result.matches, active: result.activeMatchOrdinal } satisfies BrowserFound);
		});
		contents.on("before-input-event", (event, input) => this.onKey(tabId, contents, event, input));
		contents.on("context-menu", (_event, params) => this.contextMenu(contents, params));
	}

	/** Browser keys inside a page; preventDefault also keeps the app menu's accelerators (reload, zoom) off the app window. */
	private onKey(tabId: string, contents: WebContents, event: Electron.Event, input: Input): void {
		if (input.type !== "keyDown") return;
		const ctrl = input.control || input.meta;
		const key = input.key.toLowerCase();
		const shortcut = (action: BrowserShortcut["action"]): void => {
			event.preventDefault();
			this.emit("browser:shortcut", { tabId, action } satisfies BrowserShortcut);
		};
		if (ctrl && !input.shift && key === "f") shortcut("find");
		else if (ctrl && !input.shift && key === "l") shortcut("address");
		else if (ctrl && !input.shift && key === "t") shortcut("new-tab");
		else if (ctrl && !input.shift && key === "w") shortcut("close-tab");
		else if (key === "f5" || (ctrl && key === "r")) {
			event.preventDefault();
			if (input.shift || ctrl) contents.reloadIgnoringCache();
			else contents.reload();
		} else if (input.alt && !ctrl && (key === "arrowleft" || key === "arrowright")) {
			event.preventDefault();
			this.action(tabId, key === "arrowleft" ? "back" : "forward");
		} else if (ctrl && (key === "=" || key === "+" || key === "-" || key === "0")) {
			event.preventDefault();
			this.zoom(tabId, key === "0" ? 0 : key === "-" ? -1 : 1);
		} else if (key === "escape") {
			// The page still gets its Escape; the find bar closes as well.
			this.emit("browser:shortcut", { tabId, action: "escape" } satisfies BrowserShortcut);
		} else if (isAppShortcut(input, ctrl)) {
			event.preventDefault();
			this.emit("browser:key", { key: input.key, ctrl, shift: input.shift, alt: input.alt } satisfies BrowserForwardedKey);
		}
	}

	/** A page gets no menu of its own in Electron: edit, spelling and link items, drawn natively above everything. */
	private contextMenu(contents: WebContents, params: ContextMenuParams): void {
		if (contents.isDestroyed()) return;
		const items: MenuItemConstructorOptions[] = [];
		for (const word of params.dictionarySuggestions.slice(0, 5)) {
			items.push({ label: word, click: () => contents.replaceMisspelling(word) });
		}
		if (params.misspelledWord) {
			items.push({ label: "Add to dictionary", click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
			items.push({ type: "separator" });
		}
		const link = params.linkURL && isAllowedUrl(params.linkURL) && params.linkURL !== "about:blank" ? params.linkURL : null;
		if (link) {
			items.push({ label: "Open link in new tab", click: () => this.openAsTab(link) });
			items.push({ label: "Open link in system browser", click: () => void shell.openExternal(link) });
			items.push({ label: "Copy link address", click: () => clipboard.writeText(link) });
			items.push({ type: "separator" });
		}
		if (params.isEditable) {
			items.push({ role: "undo", enabled: params.editFlags.canUndo });
			items.push({ role: "redo", enabled: params.editFlags.canRedo });
			items.push({ type: "separator" });
			items.push({ role: "cut", enabled: params.editFlags.canCut });
			items.push({ role: "copy", enabled: params.editFlags.canCopy });
			items.push({ role: "paste", enabled: params.editFlags.canPaste });
			items.push({ role: "selectAll" });
		} else if (params.selectionText.trim()) {
			items.push({ role: "copy" });
		}
		if (!params.isEditable && !link) {
			if (items.length > 0) items.push({ type: "separator" });
			items.push({ label: "Back", enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() });
			items.push({ label: "Forward", enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() });
			items.push({ label: "Reload", click: () => contents.reload() });
		}
		const window = this.getWindow();
		if (items.length > 0 && window && !window.isDestroyed()) Menu.buildFromTemplate(items).popup({ window });
	}

	private settle(requestId: string, allow: boolean): void {
		const request = this.pending.get(requestId);
		if (!request) return;
		this.pending.delete(requestId);
		clearTimeout(request.timer);
		for (const callback of request.callbacks) callback(allow);
		this.emit("browser:permission-done", { requestId });
	}

	/** The browser session's rules, set once for the partition. */
	private ensureSession(): void {
		if (this.browserSession) return;
		const ses = session.fromPartition(BROWSER_PARTITION);
		this.browserSession = ses;

		// Look like the Chrome it is: some sites refuse "Electron" or an unknown app in the user agent.
		const appToken = new RegExp(`\\s(Electron|${app.getName().replace(/[^\w-]/g, "")})\\/\\S+`, "gi");
		ses.setUserAgent(ses.getUserAgent().replace(appToken, ""));

		// No file:// at all from a page: the app's own files and Windows network paths stay out of reach.
		ses.webRequest.onBeforeRequest((details, callback) => {
			callback({ cancel: /^file:/i.test(details.url) });
		});

		ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
			const origin = originOf(requestingOrigin);
			return origin !== null && decidePermission(permission, origin, this.grants) === "allow";
		});
		ses.setPermissionRequestHandler((contents, permission, callback, details) => {
			const tabId = this.byContents.get(contents.id);
			const origin = originOf(details.requestingUrl || contents.getURL());
			if (!tabId || !origin) {
				callback(false);
				return;
			}
			const decision = decidePermission(permission, origin, this.grants);
			if (decision !== "ask") {
				callback(decision === "allow");
				return;
			}
			// The same question twice while the first is open waits for the one answer.
			for (const request of this.pending.values()) {
				if (request.tabId === tabId && request.origin === origin && request.permission === permission) {
					request.callbacks.push(callback);
					return;
				}
			}
			this.nextRequest += 1;
			const requestId = `perm-${this.nextRequest}`;
			const timer = setTimeout(() => this.settle(requestId, false), PERMISSION_TIMEOUT_MS);
			this.pending.set(requestId, { tabId, origin, permission, callbacks: [callback], timer });
			this.emit("browser:permission", { requestId, tabId, origin, permission } satisfies BrowserPermissionRequest);
		});
		// USB, HID, serial and Bluetooth devices: never.
		ses.setDevicePermissionHandler(() => false);

		// A site that asks for a client certificate gets none: a page never picks one of the user's.
		// (No WebContents, e.g. a service worker: refused too; the app's own pages never need one.)
		app.on("select-client-certificate", (event, contents, _url, _list, callback) => {
			if (contents && contents.session !== ses) return;
			event.preventDefault();
			callback();
		});

		// Leftovers of downloads that were never answered before TeezAI quit.
		rmSync(this.pendingDir, { recursive: true, force: true });
		ses.on("will-download", (_event, item, contents) => this.onDownload(item, contents));
	}

	// ---------- downloads ----------

	/**
	 * A page starts a download: blocked types and a fourth waiting question are
	 * refused; anything else goes to a private temp folder, paused, while the
	 * panel asks "Save <name> (<size>) from <host>?". Only a yes moves it into
	 * Downloads (with its Mark-of-the-Web); a no, a closed tab or 60 seconds
	 * of silence throw it away.
	 */
	private onDownload(item: DownloadItem, contents: WebContents): void {
		const tabId = this.byContents.get(contents.id) ?? null;
		const suggested = item.getFilename();
		const name = safeFileName(suggested);
		const waiting = [...this.downloads.values()].filter((d) => d.tabId === tabId && d.answer === "waiting").length;
		const gate: DownloadGate = tabId ? downloadGate(suggested, waiting) : { action: "refuse", reason: "it did not come from a browser tab" };
		if (gate.action === "refuse") {
			item.cancel();
			this.emit("browser:download", { name, state: "failed", path: "", reason: gate.reason } satisfies BrowserDownload);
			return;
		}
		this.nextDownload += 1;
		const id = `dl-${this.nextDownload}`;
		const record: PendingDownload = {
			id,
			tabId: tabId ?? "",
			name,
			item,
			url: item.getURL(),
			temp: join(this.pendingDir, id, name),
			answer: "waiting",
			finished: null,
			timer: setTimeout(() => this.answerDownload(id, false), DOWNLOAD_CONFIRM_MS),
		};
		this.downloads.set(id, record);
		// Nothing lands in Downloads before a yes; pausing also stops it using the network meanwhile.
		item.setSavePath(record.temp);
		item.pause();
		item.on("updated", () => {
			if (record.answer === "waiting" && !item.isPaused()) item.pause();
		});
		item.once("done", (_event, state) => {
			record.finished = state === "completed" ? "completed" : "failed";
			if (record.answer === "save") void this.finishDownload(record);
			else if (record.answer === "cancel") this.dropDownload(record);
			// Still waiting: the finished temp file is kept until the answer.
		});
		let host = "this page";
		try {
			host = new URL(record.url).host || host;
		} catch {
			// A blob: or data: address names no host.
		}
		this.emit("browser:download-ask", { id, tabId: record.tabId, name, size: formatBytes(item.getTotalBytes()), host } satisfies BrowserDownloadAsk);
	}

	/** Save or Cancel on the panel's download bar (or the 60-second timeout). */
	answerDownload(id: string, save: boolean): void {
		const record = this.downloads.get(id);
		if (!record || record.answer !== "waiting") return;
		clearTimeout(record.timer);
		this.emit("browser:download-asked", { id });
		if (!save) {
			record.answer = "cancel";
			if (record.finished === null) record.item.cancel();
			else this.dropDownload(record);
			return;
		}
		record.answer = "save";
		this.emit("browser:download", { name: record.name, state: "progress", path: "" } satisfies BrowserDownload);
		if (record.finished !== null) void this.finishDownload(record);
		else record.item.resume();
	}

	/** The temp file, marked as downloaded and moved into Downloads under a free name. */
	private async finishDownload(record: PendingDownload): Promise<void> {
		if (record.finished !== "completed") {
			this.emit("browser:download", { name: record.name, state: "failed", path: "" } satisfies BrowserDownload);
			this.dropDownload(record);
			return;
		}
		let path = "";
		try {
			// Marked before it moves, so it never sits in Downloads without its zone (rename and copy keep the stream).
			if (process.platform === "win32") await writeFile(`${record.temp}:Zone.Identifier`, zoneIdentifier(record.url), "utf8");
			mkdirSync(this.downloadsDir, { recursive: true });
			path = uniquePath(this.downloadsDir, record.name, (p) => existsSync(p) || this.reserved.has(p));
			this.reserved.add(path);
			try {
				await rename(record.temp, path);
			} catch {
				await copyFile(record.temp, path, fsConstants.COPYFILE_EXCL);
			}
			this.emit("browser:download", { name: path.split(/[\\/]/).pop() ?? record.name, state: "done", path } satisfies BrowserDownload);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.emit("browser:download", { name: record.name, state: "failed", path: "", reason } satisfies BrowserDownload);
		} finally {
			if (path) this.reserved.delete(path);
			this.dropDownload(record);
		}
	}

	/** Forgets a download and removes its temp folder. */
	private dropDownload(record: PendingDownload): void {
		clearTimeout(record.timer);
		this.downloads.delete(record.id);
		void rm(dirname(record.temp), { recursive: true, force: true }).catch(() => undefined);
	}
}
