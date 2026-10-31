import { create } from "zustand";
import type { FeedItem, FeedKind } from "../../shared/feed.ts";
import type { EngineStatus } from "../../shared/feed-engine.ts";
import type { VaultSource } from "../../shared/feed-history.ts";
import { useUi } from "./ui.ts";
import { useBrain } from "./brain.ts";
import { showView } from "../shell/dock-actions.ts";

/**
 * The Feed view's mirror of the main process's queue. The queue itself lives
 * (and runs) in the main process; this store only listens and asks. What
 * happened to a skill draft this session (installed, discarded) is kept here
 * so the buttons can settle without another round trip.
 */

export type DraftState = "installed" | "discarded";

/** A draft shown for review before it is installed. */
export type SkillReview = { readonly name: string; readonly skillMd: string; readonly files: readonly string[]; readonly digest: string };

type FeedState = {
	readonly items: readonly FeedItem[];
	readonly hasGroq: boolean | null;
	readonly hasGemini: boolean | null;
	/** The engine in use, its model and the last quota error; null until asked. */
	readonly engine: EngineStatus | null;
	/** Source notes in the vault that a feed job wrote (for History). */
	readonly vaultNotes: readonly VaultSource[];
	readonly drafts: Readonly<Record<string, DraftState>>;
	readonly start: () => () => void;
	readonly add: (source: string, kind: FeedKind, note: string) => Promise<boolean>;
	readonly setGroq: (key: string) => Promise<boolean>;
	readonly setGemini: (key: string) => Promise<boolean>;
	readonly refreshKeys: () => Promise<void>;
	readonly refreshEngine: () => Promise<void>;
	readonly refreshHistory: () => Promise<void>;
	/** The draft on review (SKILL.md and its files), waiting for Install or Cancel. */
	readonly review: SkillReview | null;
	/** Shows the draft for review; nothing is installed yet. */
	readonly install: (name: string) => Promise<void>;
	readonly confirmInstall: () => Promise<void>;
	readonly cancelInstall: () => void;
	readonly discard: (name: string) => Promise<void>;
	readonly openNote: (path: string) => Promise<void>;
};

const toast = (text: string, tone: "info" | "error" | "success" = "info"): void => useUi.getState().toast(text, tone);

export const useFeed = create<FeedState>((set, get) => ({
	items: [],
	hasGroq: null,
	hasGemini: null,
	engine: null,
	vaultNotes: [],
	drafts: {},

	/** Loads the queue and follows it; returns the unsubscribe. */
	start: () => {
		const off = window.teez.feed.onChange((items) => set({ items }));
		void window.teez.feed.list().then((items) => set({ items }));
		void get().refreshKeys();
		void get().refreshEngine();
		void get().refreshHistory();
		return off;
	},

	add: async (source, kind, note) => {
		const result = await window.teez.feed.add(source, kind, note);
		if ("id" in result) return true;
		toast(result.error, "error");
		return false;
	},

	setGroq: async (key) => {
		const result = await window.teez.feed.setGroq(key);
		if (!result.ok) {
			toast(result.message, "error");
			return false;
		}
		set({ hasGroq: true });
		toast("Groq key saved.", "success");
		void get().refreshEngine();
		return true;
	},

	setGemini: async (key) => {
		const result = await window.teez.feed.setGemini(key);
		if (!result.ok) {
			toast(result.message, "error");
			return false;
		}
		set({ hasGemini: true });
		toast("Gemini key saved.", "success");
		void get().refreshEngine();
		return true;
	},

	refreshKeys: async () => {
		const [hasGroq, hasGemini] = await Promise.all([window.teez.feed.hasGroq(), window.teez.feed.hasGemini()]);
		set({ hasGroq, hasGemini });
	},

	refreshEngine: async () => {
		set({ engine: await window.teez.feed.engineStatus() });
	},

	refreshHistory: async () => {
		set({ vaultNotes: await window.teez.feed.history() });
	},

	review: null,

	install: async (name) => {
		const preview = await window.teez.feed.previewSkill(name);
		if (!preview.ok) {
			toast(preview.reason, "error");
			return;
		}
		set({ review: { name, skillMd: preview.skillMd, files: preview.files, digest: preview.digest } });
		useUi.getState().setDialog("skill-review");
	},

	confirmInstall: async () => {
		const review = get().review;
		get().cancelInstall();
		if (!review) return;
		const result = await window.teez.feed.installSkill(review.name, review.digest);
		if (!result.ok) {
			toast(result.reason, "error");
			return;
		}
		set({ drafts: { ...get().drafts, [review.name]: "installed" } });
		toast(`Installed the ${review.name} skill.`, "success");
	},

	cancelInstall: () => {
		set({ review: null });
		if (useUi.getState().dialog === "skill-review") useUi.getState().setDialog(null);
	},

	discard: async (name) => {
		const result = await window.teez.feed.discardSkill(name);
		if (!result.ok) {
			toast(result.reason, "error");
			return;
		}
		set({ drafts: { ...get().drafts, [name]: "discarded" } });
	},

	/** A note the job wrote, in the Brain view. */
	openNote: async (path) => {
		await useBrain.getState().refresh();
		await useBrain.getState().open(path);
		showView("brain");
	},
}));
