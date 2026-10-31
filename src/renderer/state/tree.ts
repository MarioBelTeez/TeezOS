import { create } from "zustand";
import type { DirEntry } from "../../main/workspace/files.ts";
import type { GitStatus } from "../../main/workspace/git.ts";

/**
 * The file tree of each workspace: which folders are open, what they hold,
 * and the git status drawn over them. Folders are read when first opened and
 * re-read when the watcher says they changed — never the whole tree at once,
 * which for a folder with node_modules would be hundreds of thousands of files.
 */

export type DirState =
	| { readonly state: "loading" }
	| { readonly state: "ready"; readonly entries: readonly DirEntry[] }
	| { readonly state: "error"; readonly reason: string };

export type WorkspaceTree = {
	readonly dirs: Readonly<Record<string, DirState>>;
	readonly expanded: Readonly<Record<string, true>>;
	readonly git: GitStatus | null;
	readonly selected: string | null;
};

const EMPTY_TREE: WorkspaceTree = { dirs: {}, expanded: { "": true }, git: null, selected: null };

type TreeState = {
	readonly trees: Readonly<Record<string, WorkspaceTree>>;
	readonly tree: (workspaceId: string) => WorkspaceTree;
	readonly loadDir: (workspaceId: string, dir: string) => Promise<void>;
	readonly toggle: (workspaceId: string, dir: string) => void;
	readonly expandTo: (workspaceId: string, path: string) => Promise<void>;
	readonly collapseAll: (workspaceId: string) => void;
	readonly select: (workspaceId: string, path: string | null) => void;
	readonly refresh: (workspaceId: string, dirs: readonly string[]) => void;
	readonly refreshGit: (workspaceId: string) => Promise<void>;
};

export const useTree = create<TreeState>((set, get) => {
	const patch = (workspaceId: string, change: (tree: WorkspaceTree) => WorkspaceTree): void => {
		const trees = get().trees;
		set({ trees: { ...trees, [workspaceId]: change(trees[workspaceId] ?? EMPTY_TREE) } });
	};

	return {
		trees: {},

		tree: (workspaceId) => get().trees[workspaceId] ?? EMPTY_TREE,

		loadDir: async (workspaceId, dir) => {
			const before = get().tree(workspaceId).dirs[dir];
			if (!before) {
				patch(workspaceId, (t) => ({ ...t, dirs: { ...t.dirs, [dir]: { state: "loading" } } }));
			}
			const result = await window.teez.files.list(workspaceId, dir);
			const next: DirState = result.ok
				? { state: "ready", entries: result.entries }
				: { state: "error", reason: result.reason };
			patch(workspaceId, (t) => ({ ...t, dirs: { ...t.dirs, [dir]: next } }));
		},

		toggle: (workspaceId, dir) => {
			const tree = get().tree(workspaceId);
			if (tree.expanded[dir]) {
				patch(workspaceId, (t) => {
					const expanded = { ...t.expanded };
					delete expanded[dir];
					return { ...t, expanded };
				});
				return;
			}
			patch(workspaceId, (t) => ({ ...t, expanded: { ...t.expanded, [dir]: true } }));
			if (!tree.dirs[dir]) void get().loadDir(workspaceId, dir);
		},

		/** Open every folder above a path, e.g. to reveal the active file. */
		expandTo: async (workspaceId, path) => {
			const parts = path.split("/");
			parts.pop();
			let current = "";
			const toLoad: string[] = [""];
			for (const part of parts) {
				current = current ? `${current}/${part}` : part;
				toLoad.push(current);
			}
			patch(workspaceId, (t) => ({
				...t,
				expanded: { ...t.expanded, ...Object.fromEntries(toLoad.map((d) => [d, true as const])) },
				selected: path,
			}));
			for (const dir of toLoad) {
				if (!get().tree(workspaceId).dirs[dir]) await get().loadDir(workspaceId, dir);
			}
		},

		collapseAll: (workspaceId) => patch(workspaceId, (t) => ({ ...t, expanded: { "": true } })),

		select: (workspaceId, path) => patch(workspaceId, (t) => ({ ...t, selected: path })),

		/** Re-read the folders the watcher named, if they have been read before. */
		refresh: (workspaceId, dirs) => {
			const tree = get().tree(workspaceId);
			for (const dir of dirs) {
				if (tree.dirs[dir]) void get().loadDir(workspaceId, dir);
			}
		},

		refreshGit: async (workspaceId) => {
			const git = await window.teez.git.status(workspaceId);
			patch(workspaceId, (t) => ({ ...t, git }));
		},
	};
});

/**
 * The badge for a path: its own letter, or for a folder the strongest letter
 * of anything inside it, so a change deep down still shows at the top.
 */
const STRENGTH: Readonly<Record<string, number>> = { C: 6, D: 5, M: 4, R: 3, A: 2, U: 1 };

export function gitLetterFor(
	git: GitStatus | null,
	path: string,
	kind: "dir" | "file",
): string | null {
	if (!git) return null;
	const own = git.files[path] ?? git.files[`${path}/`];
	if (own) return own;
	if (kind === "file") {
		// Inside an untracked folder ("new-folder/"), everything is untracked.
		for (const key of Object.keys(git.files)) {
			if (key.endsWith("/") && path.startsWith(key)) return git.files[key] ?? null;
		}
		return null;
	}
	let best: string | null = null;
	const prefix = `${path}/`;
	for (const [key, letter] of Object.entries(git.files)) {
		if (!key.startsWith(prefix)) continue;
		if (!best || (STRENGTH[letter] ?? 0) > (STRENGTH[best] ?? 0)) best = letter;
	}
	return best;
}
