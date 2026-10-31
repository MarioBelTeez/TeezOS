import { create } from "zustand";
import type { BrowserDownload, BrowserDownloadAsk, BrowserFound, BrowserPermissionRequest, BrowserTabState, Rect } from "../../main/browser/manager.ts";
import { MAX_BROWSER_TABS, type BrowserPin } from "../../shared/modules.ts";
import type { ComposerMenu, View } from "./ui.ts";

/**
 * The browser's tabs as the window knows them. The pages themselves live in
 * the main process (one native view per tab) and keep running while the
 * Browser panel is closed or on another desk; this store is the list, which
 * one is in front, and the page state the main process reports.
 */

export type BrowserTab = {
	readonly id: string;
	readonly url: string;
	readonly title: string;
	readonly favicon: string | null;
	readonly loading: boolean;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	/** Percent. */
	readonly zoom: number;
	/** The pin's URL for a pinned tab (the page may since have moved on), else null. */
	readonly pin: string | null;
};

export type { Rect };

type BrowserState = {
	readonly tabs: readonly BrowserTab[];
	readonly activeId: string | null;
	/** Something is drawn where the page is (palette, menu, popover, Settings): the native view must hide. */
	readonly overlay: boolean;
	readonly prompts: readonly BrowserPermissionRequest[];
	readonly found: BrowserFound | null;
	readonly findOpen: boolean;
	/** Bumped to ask the address bar to take the focus. */
	readonly addressFocus: number;
	readonly download: BrowserDownload | null;
	/** Downloads waiting for Save or Cancel, oldest first. */
	readonly downloadAsks: readonly BrowserDownloadAsk[];
	readonly answerDownload: (id: string, save: boolean) => void;
	/** The pins have been opened as tabs this run (on the panel's first show). */
	readonly pinsOpened: boolean;
	/** The new tab's id, or null at the tab limit. */
	readonly openTab: (url: string, options?: { readonly pinned?: boolean; readonly activate?: boolean; readonly title?: string }) => string | null;
	readonly closeTab: (id: string) => void;
	readonly activate: (id: string) => void;
	readonly update: (state: BrowserTabState) => void;
	readonly ensurePins: (pins: readonly BrowserPin[]) => void;
	readonly setPin: (id: string, pin: string | null) => void;
	readonly setFind: (open: boolean) => void;
	readonly focusAddress: () => void;
	readonly answer: (requestId: string, allow: boolean) => void;
	/** Forget every tab (the main process has closed their pages), e.g. when the module is turned off. */
	readonly reset: () => void;
};

/** The page area on screen, or null when it must not be drawn: panel hidden, nothing to show, or covered. */
export function viewBounds(rect: DOMRect | null, opts: { readonly visible: boolean; readonly overlay: boolean }): Rect | null {
	if (!rect || !opts.visible || opts.overlay) return null;
	const bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
	return bounds.width > 0 && bounds.height > 0 ? bounds : null;
}

/**
 * Whether the window has something open that the page (drawn above everything) would hide.
 * A toast counts: toasts float over the desk, and one under the page would never be seen
 * (the page comes back when the toast goes, after a few seconds or a click on its X).
 */
export function coveredBy(ui: {
	readonly palette: string;
	readonly menu: unknown;
	readonly view: View;
	readonly composerMenu: ComposerMenu | null;
	readonly dialog: string | null;
	readonly toasts: readonly unknown[];
}): boolean {
	return ui.palette !== "closed" || ui.menu !== null || ui.view === "settings" || ui.composerMenu !== null || ui.dialog !== null || ui.toasts.length > 0;
}

/** Which tab is in front after one closes: the same one, else the closed tab's right neighbour, else its left. */
export function activeAfterClose(tabs: readonly BrowserTab[], closedId: string, activeId: string | null): string | null {
	if (activeId !== closedId) return activeId;
	const index = tabs.findIndex((t) => t.id === closedId);
	const rest = tabs.filter((t) => t.id !== closedId);
	if (rest.length === 0) return null;
	return (rest[Math.min(Math.max(index, 0), rest.length - 1)] ?? rest[0])?.id ?? null;
}

/** What a pin keeps of a page's address: origin and path, never a query or hash (they carry session tokens). */
export function pinUrlOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return null;
	}
}

/** Pins with no pinned tab yet. */
export function missingPins(tabs: readonly BrowserTab[], pins: readonly BrowserPin[]): BrowserPin[] {
	return pins.filter((pin) => !tabs.some((t) => t.pin === pin.url));
}

let counter = 0;
function newTabId(): string {
	counter += 1;
	return `bt-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export const useBrowser = create<BrowserState>((set, get) => ({
	tabs: [],
	activeId: null,
	overlay: false,
	prompts: [],
	found: null,
	findOpen: false,
	addressFocus: 0,
	download: null,
	downloadAsks: [],
	pinsOpened: false,

	openTab: (url, options) => {
		if (get().tabs.length >= MAX_BROWSER_TABS) return null;
		const id = newTabId();
		const pinned = options?.pinned ?? false;
		const tab: BrowserTab = {
			id,
			url,
			title: options?.title ?? url,
			favicon: null,
			loading: true,
			canGoBack: false,
			canGoForward: false,
			zoom: 100,
			pin: pinned ? url : null,
		};
		const { tabs, activeId } = get();
		// Pinned tabs stay together at the start of the strip.
		const lastPinned = tabs.reduce((last, t, i) => (t.pin !== null ? i : last), -1);
		const next = pinned ? [...tabs.slice(0, lastPinned + 1), tab, ...tabs.slice(lastPinned + 1)] : [...tabs, tab];
		const activate = (options?.activate ?? true) || activeId === null;
		set({ tabs: next, activeId: activate ? id : activeId, ...(activate ? { findOpen: false, found: null } : {}) });
		window.teez.browser.create(id, url);
		return id;
	},

	closeTab: (id) => {
		const { tabs, activeId, prompts, downloadAsks } = get();
		if (!tabs.some((t) => t.id === id)) return;
		window.teez.browser.close(id);
		const nextActive = activeAfterClose(tabs, id, activeId);
		set({
			tabs: tabs.filter((t) => t.id !== id),
			activeId: nextActive,
			prompts: prompts.filter((p) => p.tabId !== id),
			// Closing the tab cancels its downloads in the main process.
			downloadAsks: downloadAsks.filter((d) => d.tabId !== id),
			...(nextActive !== activeId ? { findOpen: false, found: null } : {}),
		});
	},

	activate: (id) => {
		const { tabs, activeId } = get();
		if (id === activeId || !tabs.some((t) => t.id === id)) return;
		if (activeId) window.teez.browser.stopFind(activeId);
		set({ activeId: id, findOpen: false, found: null });
	},

	update: (state) =>
		set({
			tabs: get().tabs.map((t) =>
				t.id === state.tabId
					? {
							...t,
							url: state.url || t.url,
							title: state.title || state.url || t.title,
							favicon: state.favicon,
							loading: state.loading,
							canGoBack: state.canGoBack,
							canGoForward: state.canGoForward,
							zoom: state.zoom,
						}
					: t,
			),
		}),

	ensurePins: (pins) => {
		for (const pin of missingPins(get().tabs, pins)) get().openTab(pin.url, { pinned: true, activate: false, title: pin.title });
	},

	setPin: (id, pin) => {
		const { tabs } = get();
		const tab = tabs.find((t) => t.id === id);
		if (!tab) return;
		const updated = { ...tab, pin };
		const rest = tabs.filter((t) => t.id !== id);
		const pinnedCount = rest.filter((t) => t.pin !== null).length;
		// A newly pinned tab joins the end of the pinned group; an unpinned one leads the rest.
		set({ tabs: [...rest.slice(0, pinnedCount), updated, ...rest.slice(pinnedCount)] });
	},

	setFind: (open) => {
		const { activeId } = get();
		if (!open && activeId) window.teez.browser.stopFind(activeId);
		set({ findOpen: open, ...(open ? {} : { found: null }) });
	},

	focusAddress: () => set({ addressFocus: get().addressFocus + 1 }),

	answer: (requestId, allow) => {
		window.teez.browser.answerPermission(requestId, allow);
		set({ prompts: get().prompts.filter((p) => p.requestId !== requestId) });
	},

	answerDownload: (id, save) => {
		window.teez.browser.answerDownload(id, save);
		set({ downloadAsks: get().downloadAsks.filter((d) => d.id !== id) });
	},

	reset: () => set({ tabs: [], activeId: null, prompts: [], found: null, findOpen: false, download: null, downloadAsks: [], pinsOpened: false }),
}));
