import { create } from "zustand";
import { createHistory } from "../../shared/history.ts";
import type { NoteView, VaultIndex } from "../../main/brain/vault.ts";

/** Brain's state: the vault index, the note on screen, and a back/forward history. */

type Index = VaultIndex & { readonly root: string };

type BrainState = {
	readonly index: Index | null;
	readonly note: NoteView | null;
	readonly current: string | null;
	readonly canBack: boolean;
	readonly canForward: boolean;
	readonly mode: "note" | "graph";
	readonly loading: boolean;
	readonly load: () => Promise<void>;
	readonly open: (path: string) => Promise<void>;
	readonly openLink: (target: string) => Promise<boolean>;
	readonly back: () => void;
	readonly forward: () => void;
	readonly setMode: (mode: "note" | "graph") => void;
	readonly refresh: () => Promise<void>;
};

/** The notes opened, in order; back and forward move along it without adding to it. */
const trail = createHistory<string>();

export const useBrain = create<BrainState>((set, get) => ({
	index: null,
	note: null,
	current: null,
	canBack: false,
	canForward: false,
	mode: "note",
	loading: false,

	load: async () => {
		set({ loading: true });
		const index = await window.teez.brain.index();
		set({ index, loading: false });
		if (index && !get().current) {
			const home = index.notes.find((n) => n.path === "Home.md") ?? index.notes[0];
			if (home) await get().open(home.path);
		}
	},

	open: async (path) => {
		const note = await window.teez.brain.note(path);
		if (!note) return;
		// Arriving by back/forward re-pushes the entry in front, which the trail ignores.
		trail.push(path);
		set({ note, current: path, canBack: trail.canBack(), canForward: trail.canForward(), mode: "note" });
	},

	/** Follow a [[wikilink]] as Obsidian would. False when it leads nowhere. */
	openLink: async (target) => {
		const note = get().note;
		const index = get().index;
		const bare = target.split("#")[0]?.trim() ?? "";
		// A .base, a canvas or an image: Obsidian shows those, not the reader.
		const file = note?.outgoing.find((o) => (o.target === target || o.target === bare) && o.kind === "file");
		if (file?.path) {
			await window.teez.brain.openInObsidian(file.path);
			return true;
		}
		const resolved =
			note?.outgoing.find((o) => o.target === target || o.target === bare)?.path ??
			index?.notes.find((n) => n.title.toLowerCase() === bare.toLowerCase())?.path ??
			index?.notes.find((n) => n.aliases.some((a) => a.toLowerCase() === bare.toLowerCase()))?.path ??
			index?.notes.find((n) => n.path.toLowerCase() === `${bare.toLowerCase()}.md`)?.path;
		if (!resolved) return false;
		await get().open(resolved);
		return true;
	},

	back: () => {
		const path = trail.back();
		if (path === undefined) return;
		// A note that cannot be opened leaves the trail where it was.
		void get().open(path).then(() => {
			if (get().current !== path) trail.forward();
		});
	},

	forward: () => {
		const path = trail.forward();
		if (path === undefined) return;
		void get().open(path).then(() => {
			if (get().current !== path) trail.back();
		});
	},

	setMode: (mode) => set({ mode }),

	/** After the vault changed on disk: new index, and the open note re-read. */
	refresh: async () => {
		const index = await window.teez.brain.index();
		const current = get().current;
		const note = current ? await window.teez.brain.note(current) : null;
		set({ index, ...(note ? { note } : {}) });
	},
}));
