import { create } from "zustand";
import { monaco } from "../editor/monaco.ts";

/**
 * Open files per workspace. The text lives in Monaco models (one per file,
 * shared by every view of it); this store keeps the tabs and whether each one
 * has unsaved changes.
 *
 * A single click opens a *preview* tab that the next single click replaces,
 * as in VS Code; editing it or double-clicking makes it stay.
 */

export type TabKind = "text" | "image" | "binary" | "too-large" | "error";

export type Tab = {
	readonly path: string;
	readonly kind: TabKind;
	readonly dirty: boolean;
	readonly preview: boolean;
	/** Showing the diff against the last commit rather than the editor. */
	readonly diff: boolean;
	readonly dataUrl?: string;
	readonly size?: number;
	readonly error?: string;
	/** The file changed on disk while it had unsaved edits here. */
	readonly conflict?: boolean;
	/** Not UTF-8 on disk: shown, never saved. */
	readonly readOnly?: boolean;
	/** A Markdown file shown rendered rather than as source. */
	readonly rendered?: boolean;
};

type WorkspaceTabs = { readonly tabs: readonly Tab[]; readonly active: string | null };

type EditorState = {
	readonly byWorkspace: Readonly<Record<string, WorkspaceTabs>>;
	readonly open: (
		workspaceId: string,
		path: string,
		options?: { readonly preview?: boolean; readonly diff?: boolean; readonly line?: number },
	) => Promise<void>;
	readonly activate: (workspaceId: string, path: string) => void;
	readonly close: (workspaceId: string, path: string) => void;
	readonly closeOthers: (workspaceId: string, path: string) => void;
	readonly pin: (workspaceId: string, path: string) => void;
	readonly toggleDiff: (workspaceId: string, path: string) => void;
	readonly toggleRendered: (workspaceId: string, path: string) => void;
	readonly save: (workspaceId: string, path: string) => Promise<boolean>;
	readonly markDirty: (workspaceId: string, path: string, dirty: boolean) => void;
	readonly reloadChanged: (workspaceId: string, dirs: readonly string[]) => Promise<void>;
	/** A line to reveal once the editor shows the file. */
	readonly pendingLine: { readonly key: string; readonly line: number } | null;
	readonly clearPendingLine: () => void;
};

const EMPTY: WorkspaceTabs = { tabs: [], active: null };

/** The saved version of each open file, to tell edits from the original. */
const savedVersions = new Map<string, number>();
/** Models being reloaded from disk: their content change is not the user's edit. */
const reloading = new Set<string>();
/** Opens in flight, so a double click does not make two tabs. */
const opening = new Map<string, Promise<void>>();

export function modelKey(workspaceId: string, path: string): string {
	return `${workspaceId}::${path}`;
}

export function modelUri(workspaceId: string, path: string): monaco.Uri {
	// The path's extension in the URI is how Monaco picks the language.
	return monaco.Uri.from({ scheme: "teez", authority: workspaceId, path: `/${path}` });
}

export function getModel(workspaceId: string, path: string): monaco.editor.ITextModel | null {
	return monaco.editor.getModel(modelUri(workspaceId, path));
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

export const useEditor = create<EditorState>((set, get) => {
	const patch = (workspaceId: string, change: (tabs: WorkspaceTabs) => WorkspaceTabs): void => {
		const all = get().byWorkspace;
		set({ byWorkspace: { ...all, [workspaceId]: change(all[workspaceId] ?? EMPTY) } });
	};

	const updateTab = (workspaceId: string, path: string, change: (tab: Tab) => Tab): void =>
		patch(workspaceId, (ws) => ({
			...ws,
			tabs: ws.tabs.map((tab) => (tab.path === path ? change(tab) : tab)),
		}));

	return {
		byWorkspace: {},
		pendingLine: null,

		open: async (workspaceId, path, options = {}) => {
			const key = modelKey(workspaceId, path);
			const inFlight = opening.get(key);
			if (inFlight) {
				await inFlight;
				if (options.line) set({ pendingLine: { key, line: options.line } });
				get().activate(workspaceId, path);
				return;
			}
			const ws = get().byWorkspace[workspaceId] ?? EMPTY;
			const existing = ws.tabs.find((tab) => tab.path === path);
			if (options.line) set({ pendingLine: { key, line: options.line } });

			if (existing) {
				patch(workspaceId, (w) => ({
					...w,
					active: path,
					tabs: w.tabs.map((tab) =>
						tab.path === path
							? {
									...tab,
									preview: tab.preview && options.preview !== false,
									diff: options.diff ?? tab.diff,
								}
							: tab,
					),
				}));
				return;
			}

			let release: () => void = () => undefined;
			opening.set(key, new Promise<void>((resolve) => (release = resolve)));
			try {
				await openNew();
			} finally {
				opening.delete(key);
				release();
			}

			async function openNew(): Promise<void> {
			const file = await window.teez.files.read(workspaceId, path);
			let tab: Tab;
			if (!file.ok) {
				tab = { path, kind: "error", dirty: false, preview: false, diff: false, error: file.reason };
			} else if (file.kind === "text") {
				const uri = modelUri(workspaceId, path);
				const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(file.content, undefined, uri);
				if (model.getValue() !== file.content) model.setValue(file.content);
				savedVersions.set(modelKey(workspaceId, path), model.getAlternativeVersionId());
				tab = {
					path,
					kind: "text",
					dirty: false,
					preview: options.preview ?? false,
					diff: options.diff ?? false,
					size: file.size,
					...(file.readOnly ? { readOnly: true } : {}),
				};
			} else if (file.kind === "image") {
				tab = { path, kind: "image", dirty: false, preview: options.preview ?? false, diff: false, dataUrl: file.dataUrl, size: file.size };
			} else {
				tab = { path, kind: file.kind, dirty: false, preview: options.preview ?? false, diff: false, size: file.size };
			}

			const replaced: string[] = [];
			patch(workspaceId, (w) => {
				// A new preview replaces the old preview, unless that one was edited.
				const kept = tab.preview ? w.tabs.filter((t) => !(t.preview && !t.dirty && t.path !== path)) : w.tabs;
				for (const t of w.tabs) if (!kept.includes(t)) replaced.push(t.path);
				const activeIndex = kept.findIndex((t) => t.path === w.active);
				const tabs = [...kept];
				tabs.splice(activeIndex === -1 ? tabs.length : activeIndex + 1, 0, tab);
				return { tabs, active: path };
			});
			// The replaced preview's model would otherwise stay in memory for good.
			for (const gone of replaced) {
				savedVersions.delete(modelKey(workspaceId, gone));
				getModel(workspaceId, gone)?.dispose();
			}
			}
		},

		activate: (workspaceId, path) => patch(workspaceId, (w) => ({ ...w, active: path })),

		close: (workspaceId, path) => {
			const closing = (get().byWorkspace[workspaceId] ?? EMPTY).tabs.find((t) => t.path === path);
			if (closing?.dirty && !window.confirm(`${path.split("/").at(-1) ?? path} has unsaved changes. Close it and lose them?`)) return;
			patch(workspaceId, (w) => {
				const index = w.tabs.findIndex((t) => t.path === path);
				const tabs = w.tabs.filter((t) => t.path !== path);
				let active = w.active;
				if (w.active === path) {
					const next = tabs[Math.min(index, tabs.length - 1)];
					active = next?.path ?? null;
				}
				return { tabs, active };
			});
			// Dispose the model once no tab shows it, so memory follows the tabs.
			const key = modelKey(workspaceId, path);
			savedVersions.delete(key);
			getModel(workspaceId, path)?.dispose();
		},

		closeOthers: (workspaceId, path) => {
			const ws = get().byWorkspace[workspaceId] ?? EMPTY;
			for (const tab of ws.tabs) {
				if (tab.path !== path && !tab.dirty) get().close(workspaceId, tab.path);
			}
		},

		pin: (workspaceId, path) => updateTab(workspaceId, path, (tab) => ({ ...tab, preview: false })),

		toggleDiff: (workspaceId, path) =>
			updateTab(workspaceId, path, (tab) => ({ ...tab, diff: !tab.diff, rendered: false, preview: false })),

		toggleRendered: (workspaceId, path) =>
			updateTab(workspaceId, path, (tab) => ({ ...tab, rendered: !tab.rendered, diff: false, preview: false })),

		save: async (workspaceId, path) => {
			const model = getModel(workspaceId, path);
			if (!model) return false;
			const tab = (get().byWorkspace[workspaceId] ?? EMPTY).tabs.find((t) => t.path === path);
			if (tab?.readOnly) return false;
			// What is written is this version; typing during the write stays unsaved.
			const version = model.getAlternativeVersionId();
			const result = await window.teez.files.write(workspaceId, path, model.getValue());
			if (!result.ok) return false;
			savedVersions.set(modelKey(workspaceId, path), version);
			updateTab(workspaceId, path, (t) => ({ ...t, dirty: model.getAlternativeVersionId() !== version, conflict: false }));
			return true;
		},

		markDirty: (workspaceId, path, dirty) => {
			// Checked now: a reload from disk is suppressed only while it is applied.
			if (reloading.has(modelKey(workspaceId, path))) return;
			// Compared a microtask later: during an undo, Monaco fires the change event
			// before it restores the alternative version id (measured: 7 in the event,
			// back to 1 right after), so an undo to the saved text read as unsaved.
			queueMicrotask(() => {
				const model = getModel(workspaceId, path);
				// Undoing back to the saved text is not an unsaved change.
				const isDirty =
					dirty && !!model && model.getAlternativeVersionId() !== savedVersions.get(modelKey(workspaceId, path));
				const tab = (get().byWorkspace[workspaceId] ?? EMPTY).tabs.find((t) => t.path === path);
				if (!tab || (tab.dirty === isDirty && (!isDirty || !tab.preview))) return;
				updateTab(workspaceId, path, (t) => ({ ...t, dirty: isDirty, preview: isDirty ? false : t.preview }));
			});
		},

		/** Pick up changes made on disk (by Claude, the terminal, git). */
		reloadChanged: async (workspaceId, dirs) => {
			const ws = get().byWorkspace[workspaceId];
			if (!ws) return;
			const changed = new Set(dirs);
			for (const snapshot of ws.tabs) {
				if (snapshot.kind !== "text" || !changed.has(parentOf(snapshot.path))) continue;
				const model = getModel(workspaceId, snapshot.path);
				if (!model) continue;
				const file = await window.teez.files.read(workspaceId, snapshot.path);
				if (!file.ok || file.kind !== "text" || file.content === model.getValue()) continue;
				// Re-read the tab: it may have been saved or edited while the file was read.
				const tab = (get().byWorkspace[workspaceId] ?? EMPTY).tabs.find((t) => t.path === snapshot.path);
				if (!tab) continue;
				if (tab.dirty) {
					updateTab(workspaceId, tab.path, (t) => ({ ...t, conflict: true }));
					continue;
				}
				// Keep undo history: the reload becomes one undoable edit. The content
				// change it fires is not an edit of the user's, so it must not mark the
				// tab dirty (that then turned every later reload into a "conflict").
				const key = modelKey(workspaceId, tab.path);
				reloading.add(key);
				try {
					model.pushEditOperations([], [{ range: model.getFullModelRange(), text: file.content }], () => null);
				} finally {
					reloading.delete(key);
				}
				savedVersions.set(key, model.getAlternativeVersionId());
				updateTab(workspaceId, tab.path, (t) => ({ ...t, dirty: false, conflict: false }));
			}
		},

		clearPendingLine: () => set({ pendingLine: null }),
	};
});

// Keep the main process told how many files are unsaved: it asks before closing.
let lastUnsaved = -1;
useEditor.subscribe((state) => {
	let count = 0;
	for (const ws of Object.values(state.byWorkspace)) for (const tab of ws.tabs) if (tab.dirty) count += 1;
	if (count !== lastUnsaved) {
		lastUnsaved = count;
		window.teez.window.reportUnsaved(count);
	}
});
