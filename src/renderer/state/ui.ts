import { create } from "zustand";
import type { InsertMode } from "../chat/draft.ts";
import type { SettingsPageId } from "../views/settings/nav.ts";

/** What the window is showing right now. Not persisted: it is cheap to rebuild. */

/** The desk (every panel lives there) or the Settings page over it. */
export type View = "desk" | "settings";

export type MenuItem =
	| {
			readonly label: string;
			readonly onSelect: () => void;
			readonly danger?: boolean;
			readonly hint?: string;
			/** Shown but not clickable, e.g. a model this machine does not have. */
			readonly disabled?: boolean;
	  }
	/** A rule between groups; with a label it heads the group below it. */
	| { readonly separator: true; readonly label?: string };

/** A menu or popover of the chat composer; the pickers open themselves when theirs is set. */
export type ComposerMenu = "model" | "mode" | "effort" | "commands" | "btw" | "context";

export type Toast = {
	readonly id: number;
	readonly text: string;
	readonly tone: "info" | "error" | "success";
};

type UiState = {
	readonly view: View;
	/** The Settings section last shown; Settings reopens on it. */
	readonly settingsPage: SettingsPageId;
	/** Settings in front, on a section (else the last one). */
	readonly openSettings: (page?: SettingsPageId) => void;
	readonly palette: "closed" | "commands" | "files";
	/** `anchorTop`: the top of the button that opened it, where the menu flips to when it would overflow below. */
	readonly menu: { readonly x: number; readonly y: number; readonly anchorTop?: number; readonly items: readonly MenuItem[] } | null;
	readonly toasts: readonly Toast[];
	/** A modal dialog over the window (e.g. "skill-review"); the browser page hides while one is open. */
	readonly dialog: string | null;
	readonly setDialog: (dialog: string | null) => void;
	/** Text the chat composer should take in, e.g. "@src/main/index.ts". */
	readonly composerInsert: { readonly text: string; readonly mode: InsertMode; readonly nonce: number } | null;
	/** Which of the composer's menus is open. One at a time. */
	readonly composerMenu: ComposerMenu | null;
	readonly setComposerMenu: (menu: ComposerMenu | null) => void;
	/** A run to show when Automations opens (from a desktop notification). */
	readonly pendingRun: string | null;
	readonly setPendingRun: (runId: string | null) => void;
	readonly setView: (view: View) => void;
	readonly openPalette: (mode: "commands" | "files") => void;
	readonly closePalette: () => void;
	readonly openMenu: (x: number, y: number, items: readonly MenuItem[], anchorTop?: number) => void;
	readonly closeMenu: () => void;
	readonly toast: (text: string, tone?: Toast["tone"]) => void;
	readonly dismissToast: (id: number) => void;
	/** `prefill` puts the text before the draft (a hand-over); the default appends (a mention). */
	readonly insertIntoComposer: (text: string, options?: { readonly mode?: InsertMode }) => void;
	readonly consumeComposerInsert: () => void;
};

let toastId = 0;

export const useUi = create<UiState>((set, get) => ({
	view: "desk",
	settingsPage: "general",
	openSettings: (page) => set({ view: "settings", settingsPage: page ?? get().settingsPage }),
	palette: "closed",
	menu: null,
	toasts: [],
	dialog: null,
	setDialog: (dialog) => set({ dialog }),
	composerInsert: null,
	composerMenu: null,
	setComposerMenu: (composerMenu) => set({ composerMenu }),
	pendingRun: null,
	setPendingRun: (pendingRun) => set({ pendingRun }),
	setView: (view) => set({ view }),
	openPalette: (palette) => set({ palette }),
	closePalette: () => set({ palette: "closed" }),
	openMenu: (x, y, items, anchorTop) => set({ menu: anchorTop === undefined ? { x, y, items } : { x, y, anchorTop, items } }),
	closeMenu: () => set({ menu: null }),
	toast: (text, tone = "info") => {
		toastId += 1;
		const id = toastId;
		set({ toasts: [...get().toasts, { id, text, tone }] });
		setTimeout(() => get().dismissToast(id), tone === "error" ? 7000 : 3500);
	},
	dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
	insertIntoComposer: (text, options) =>
		set({ composerInsert: { text, mode: options?.mode ?? "append", nonce: (get().composerInsert?.nonce ?? 0) + 1 } }),
	consumeComposerInsert: () => set({ composerInsert: null }),
}));
