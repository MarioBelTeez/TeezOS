import { useEffect, useRef, useState } from "react";
import { ChevronRight, Eye, GitCompare, MessageSquarePlus, Save, X } from "lucide-react";
import type { Workspace } from "../../main/settings/store.ts";
import type { GitCommit } from "../../main/workspace/git.ts";
import { EDITOR_OPTIONS, monaco } from "./monaco.ts";
import { editorOptionsFrom } from "./editor-options.ts";
import { useShallow } from "zustand/react/shallow";
import { useSettings } from "../state/settings.ts";
import { getModel, modelKey, useEditor, type Tab } from "../state/editor.ts";
import { gitLetterFor, useTree } from "../state/tree.ts";
import { useUi } from "../state/ui.ts";
import { FileIcon, GIT_COLORS } from "../explorer/FileIcon.tsx";
import { IconButton } from "../shell/IconButton.tsx";
import { MarkdownPreview, isMarkdown } from "./MarkdownPreview.tsx";

/**
 * Tabs, a breadcrumb, and one Monaco editor that swaps models as tabs change —
 * the way VS Code does it, so switching tabs keeps each file's scroll position,
 * selection and undo history.
 */

const EMPTY_TABS = { tabs: [] as readonly Tab[], active: null as string | null };

export function EditorArea({ workspace }: { readonly workspace: Workspace }): React.JSX.Element {
	const ws = useEditor((s) => s.byWorkspace[workspace.id]) ?? EMPTY_TABS;
	const active = ws.tabs.find((tab) => tab.path === ws.active) ?? null;

	return (
		<section data-nav-area="editor" className="flex h-full min-w-0 flex-1 flex-col">
			{ws.tabs.length > 0 ? <TabBar workspace={workspace} tabs={ws.tabs} active={ws.active} /> : null}
			{active ? <Breadcrumb workspace={workspace} tab={active} /> : null}
			<div className="relative min-h-0 flex-1">
				{!active ? <Welcome workspace={workspace} /> : null}
				{active?.kind === "text" && !active.diff && !active.rendered ? <CodeEditor workspace={workspace} path={active.path} readOnly={active.readOnly ?? false} /> : null}
				{active?.kind === "text" && active.rendered && !active.diff ? <MarkdownPreview workspaceId={workspace.id} path={active.path} /> : null}
				{active?.kind === "text" && active.diff ? <DiffView workspace={workspace} path={active.path} /> : null}
				{active?.kind === "image" ? (
					<div className="flex h-full items-center justify-center overflow-auto bg-[repeating-conic-gradient(#110c0f_0%_25%,#08060a_0%_50%)] bg-[length:20px_20px] p-6">
						<img src={active.dataUrl} alt={active.path} className="max-h-full max-w-full object-contain" />
					</div>
				) : null}
				{active && (active.kind === "binary" || active.kind === "too-large" || active.kind === "error") ? (
					<div className="flex h-full flex-col items-center justify-center gap-2 font-mono text-xs text-muted">
						<p className="font-display text-2xl tracking-wider text-text">
							{active.kind === "binary" ? "BINARY FILE" : active.kind === "too-large" ? "TOO LARGE TO OPEN" : "CANNOT OPEN"}
						</p>
						<p>{active.error ?? `${Math.round((active.size ?? 0) / 1024)} KB`}</p>
						<button
							type="button"
							onClick={() => void window.teez.workspaces.reveal(workspace.id, active.path)}
							className="mt-2 cut-corner px-4 py-1 font-condensed text-xs uppercase tracking-wider ring-1 ring-border hover:ring-red/50"
						>
							Show in File Explorer
						</button>
					</div>
				) : null}
			</div>
		</section>
	);
}

function TabBar({
	workspace,
	tabs,
	active,
}: {
	readonly workspace: Workspace;
	readonly tabs: readonly Tab[];
	readonly active: string | null;
}): React.JSX.Element {
	const { activate, close, closeOthers, pin, toggleDiff, save } = useEditor.getState();
	const git = useTree((s) => s.trees[workspace.id]?.git ?? null);
	const activeTab = tabs.find((t) => t.path === active);
	const activeLetter = activeTab ? gitLetterFor(git, activeTab.path, "file") : null;

	return (
		<div className="flex h-9 shrink-0 items-stretch border-b border-border bg-surface">
			<div className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
				{tabs.map((tab) => {
					const name = tab.path.split("/").at(-1) ?? tab.path;
					const isActive = tab.path === active;
					const letter = gitLetterFor(git, tab.path, "file");
					return (
						<div
							key={tab.path}
							role="tab"
							aria-selected={isActive}
							title={tab.path}
							onClick={() => activate(workspace.id, tab.path)}
							onDoubleClick={() => pin(workspace.id, tab.path)}
							onAuxClick={(event) => {
								if (event.button === 1) close(workspace.id, tab.path);
							}}
							onContextMenu={(event) => {
								event.preventDefault();
								useUi.getState().openMenu(event.clientX, event.clientY, [
									{ label: "Close", hint: "Ctrl+W", onSelect: () => close(workspace.id, tab.path) },
									{ label: "Close others", onSelect: () => closeOthers(workspace.id, tab.path) },
									{ separator: true },
									{ label: tab.diff ? "Show file" : "Show changes", onSelect: () => toggleDiff(workspace.id, tab.path) },
									{ label: "Reveal in tree", onSelect: () => void useTree.getState().expandTo(workspace.id, tab.path) },
									{ label: "Copy path", onSelect: () => void navigator.clipboard.writeText(tab.path) },
									{ label: "Ask the agent about this", onSelect: () => useUi.getState().insertIntoComposer(`@${tab.path} `) },
								]);
							}}
							className={`group relative flex min-w-0 max-w-56 shrink-0 cursor-pointer items-center gap-2 border-r border-border px-3 text-[13px] ${
								isActive ? "bg-bg text-text" : "text-muted hover:text-text"
							}`}
						>
							{isActive ? <span className="absolute inset-x-0 top-0 h-[2px] bg-red" /> : null}
							<FileIcon name={name} />
							<span
								className={`truncate ${tab.preview ? "italic" : ""}`}
								style={letter ? { color: GIT_COLORS[letter] } : undefined}
							>
								{name}
								{tab.diff ? <span className="ml-1 text-[10px] text-muted">(changes)</span> : null}
							</span>
							<button
								type="button"
								aria-label={`Close ${name}`}
								onClick={(event) => {
									event.stopPropagation();
									close(workspace.id, tab.path);
								}}
								className="flex h-4 w-4 shrink-0 items-center justify-center text-muted hover:text-text"
							>
								{tab.dirty ? (
									<span className="h-2 w-2 rounded-full bg-text group-hover:hidden" />
								) : null}
								<X size={12} className={tab.dirty ? "hidden group-hover:block" : isActive ? "" : "opacity-0 group-hover:opacity-100"} />
							</button>
						</div>
					);
				})}
			</div>
			{activeTab ? (
				<div className="flex shrink-0 items-center gap-0.5 px-1">
					{activeTab.kind === "text" && activeLetter && activeLetter !== "U" && activeLetter !== "A" ? (
						<IconButton
							label={activeTab.diff ? "Show file" : "Show changes against the last commit"}
							active={activeTab.diff}
							onClick={() => toggleDiff(workspace.id, activeTab.path)}
						>
							<GitCompare size={15} />
						</IconButton>
					) : null}
					{activeTab.kind === "text" && isMarkdown(activeTab.path) ? (
						<IconButton
							label={activeTab.rendered ? "Show source (Ctrl+Shift+V)" : "Preview (Ctrl+Shift+V)"}
							active={activeTab.rendered ?? false}
							onClick={() => useEditor.getState().toggleRendered(workspace.id, activeTab.path)}
						>
							<Eye size={15} />
						</IconButton>
					) : null}
					<IconButton label="Ask the agent about this file" onClick={() => useUi.getState().insertIntoComposer(`@${activeTab.path} `)}>
						<MessageSquarePlus size={15} />
					</IconButton>
					{activeTab.dirty ? (
						<IconButton label="Save (Ctrl+S)" onClick={() => void save(workspace.id, activeTab.path)}>
							<Save size={15} />
						</IconButton>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function Breadcrumb({ workspace, tab }: { readonly workspace: Workspace; readonly tab: Tab }): React.JSX.Element {
	const parts = tab.path.split("/");
	return (
		<div className="flex h-6 shrink-0 items-center gap-1 overflow-hidden border-b border-border/60 bg-bg px-3 font-mono text-[10.5px] text-muted">
			<span>{workspace.name}</span>
			{parts.map((part, index) => (
				<span key={`${index}-${part}`} className="flex items-center gap-1">
					<ChevronRight size={10} />
					<span className={index === parts.length - 1 ? "text-text" : ""}>{part}</span>
				</span>
			))}
			{tab.conflict ? (
				<span className="ml-auto text-[#f5a524]">changed on disk — saving will overwrite it</span>
			) : tab.readOnly ? (
				<span className="ml-auto text-[#f5a524]">not UTF-8 — opened read-only</span>
			) : null}
		</div>
	);
}

/** Scroll position and selection per file, kept while the file stays open. */
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

function CodeEditor({
	workspace,
	path,
	readOnly,
}: {
	readonly workspace: Workspace;
	readonly path: string;
	readonly readOnly: boolean;
}): React.JSX.Element {
	const host = useRef<HTMLDivElement>(null);
	const pendingLine = useEditor((s) => s.pendingLine);
	const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const current = useRef({ workspaceId: workspace.id, path });
	current.current = { workspaceId: workspace.id, path };
	const options = useSettings(useShallow((s) => s.settings?.modules.editor));

	useEffect(() => {
		if (!host.current) return;
		const saved = useSettings.getState().settings?.modules.editor;
		const instance = monaco.editor.create(host.current, { ...EDITOR_OPTIONS, ...(saved ? editorOptionsFrom(saved) : {}), model: null });
		editor.current = instance;
		instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
			const { workspaceId, path: file } = current.current;
			void useEditor.getState().save(workspaceId, file).then((ok) => {
				if (!ok) useUi.getState().toast(`Could not save ${file}`, "error");
			});
		});
		const changes = instance.onDidChangeModelContent(() => {
			const { workspaceId, path: file } = current.current;
			useEditor.getState().markDirty(workspaceId, file, true);
		});
		return () => {
			const model = instance.getModel();
			if (model) viewStates.set(model.uri.toString(), instance.saveViewState());
			changes.dispose();
			instance.dispose();
			editor.current = null;
		};
	}, []);

	useEffect(() => {
		const instance = editor.current;
		const model = getModel(workspace.id, path);
		if (!instance || !model) return;
		const previous = instance.getModel();
		if (previous && previous !== model) viewStates.set(previous.uri.toString(), instance.saveViewState());
		if (previous !== model) {
			instance.setModel(model);
			const saved = viewStates.get(model.uri.toString());
			if (saved) instance.restoreViewState(saved);
		}
		instance.updateOptions({ readOnly });
		instance.focus();
	}, [workspace.id, path, readOnly]);

	// Settings → Editor, live: a change shows in the open editor at once.
	useEffect(() => {
		if (options) editor.current?.updateOptions(editorOptionsFrom(options));
	}, [options]);

	// A jump to a line — from search, or a tool card — also when the file is
	// already the one on screen.
	useEffect(() => {
		const instance = editor.current;
		if (!instance || !pendingLine || pendingLine.key !== modelKey(workspace.id, path)) return;
		instance.revealLineInCenter(pendingLine.line);
		instance.setPosition({ lineNumber: pendingLine.line, column: 1 });
		useEditor.getState().clearPendingLine();
	}, [pendingLine, workspace.id, path]);

	return <div ref={host} className="absolute inset-0" />;
}

/** The diff is two editors side by side: same font and wrapping, never a minimap. */
function diffOptionsFrom(options: Parameters<typeof editorOptionsFrom>[0]): monaco.editor.IDiffEditorOptions {
	const { fontSize, lineHeight, wordWrap } = editorOptionsFrom(options);
	return { fontSize, lineHeight, wordWrap, minimap: { enabled: false } };
}

function DiffView({ workspace, path }: { readonly workspace: Workspace; readonly path: string }): React.JSX.Element {
	const host = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
	const options = useSettings(useShallow((s) => s.settings?.modules.editor));
	const diff = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

	useEffect(() => {
		let disposed = false;
		let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
		let original: monaco.editor.ITextModel | null = null;
		let changes: monaco.IDisposable | null = null;
		void window.teez.git.head(workspace.id, path).then((head) => {
			const modified = getModel(workspace.id, path);
			if (disposed || !host.current || !modified) return;
			if (head === null) {
				setState("missing");
				return;
			}
			original = monaco.editor.createModel(
				head,
				modified.getLanguageId(),
				monaco.Uri.from({ scheme: "teez-head", authority: workspace.id, path: `/${path}` }),
			);
			const saved = useSettings.getState().settings?.modules.editor;
			diffEditor = monaco.editor.createDiffEditor(host.current, {
				...EDITOR_OPTIONS,
				...(saved ? diffOptionsFrom(saved) : {}),
				renderSideBySide: true,
				originalEditable: false,
				minimap: { enabled: false },
			});
			diff.current = diffEditor;
			diffEditor.setModel({ original, modified });
			// Edits made on the right-hand side are edits of the file.
			changes = modified.onDidChangeContent(() => useEditor.getState().markDirty(workspace.id, path, true));
			setState("ready");
		});
		return () => {
			disposed = true;
			changes?.dispose();
			diffEditor?.dispose();
			diff.current = null;
			original?.dispose();
		};
	}, [workspace.id, path]);

	useEffect(() => {
		if (options) diff.current?.updateOptions(diffOptionsFrom(options));
	}, [options]);

	return (
		<>
			<div ref={host} className="absolute inset-0" />
			{state === "missing" ? (
				<p className="absolute inset-0 flex items-center justify-center font-mono text-xs text-muted">
					This file is not in the last commit, so there is nothing to compare against.
				</p>
			) : null}
		</>
	);
}

function Welcome({ workspace }: { readonly workspace: Workspace }): React.JSX.Element {
	const [commits, setCommits] = useState<GitCommit[]>([]);
	const git = useTree((s) => s.trees[workspace.id]?.git ?? null);
	const openPalette = useUi((s) => s.openPalette);

	useEffect(() => {
		void window.teez.git.log(workspace.id).then(setCommits);
	}, [workspace.id, git]);

	const changed = git ? Object.entries(git.files).slice(0, 12) : [];

	return (
		<div className="h-full w-full overflow-y-auto px-10 py-10">
			{/* A centred column: on a wide window the page reads as one block instead of hugging the left edge. */}
			<div className="mx-auto w-full max-w-5xl">
				<p className="glow-text font-condensed text-xs uppercase tracking-[0.3em] text-red-hot">Workspace</p>
				<h1 className="mt-1 font-display text-6xl leading-none tracking-wide">{workspace.name}</h1>
				<p className="mt-2 font-mono text-[11px] text-muted">{workspace.path}</p>

				<div className="mt-6 flex flex-wrap gap-2">
					<WelcomeAction label="Open a file" keys="Ctrl+P" onClick={() => openPalette("files")} />
					<WelcomeAction label="Commands" keys="Ctrl+K" onClick={() => openPalette("commands")} />
					<WelcomeAction
						label="Terminal"
						keys="Ctrl+`"
						onClick={() => window.dispatchEvent(new CustomEvent("teez:toggle-terminal"))}
					/>
				</div>

				<div className="mt-10 grid gap-10 lg:grid-cols-2">
					<section>
						<h2 className="font-condensed text-xs uppercase tracking-[0.2em] text-muted">
							Recent commits{git?.branch ? ` · ${git.branch}` : ""}
						</h2>
						<ul className="mt-3 space-y-1.5">
							{commits.slice(0, 12).map((commit) => (
								<li key={commit.hash} className="flex gap-3 text-[13px]">
									<span className="shrink-0 font-mono text-[11px] text-red-hot">{commit.short}</span>
									<span className="min-w-0 flex-1 truncate">{commit.subject}</span>
									<span className="shrink-0 font-mono text-[10px] text-muted">{commit.when}</span>
								</li>
							))}
							{commits.length === 0 ? <li className="font-mono text-xs text-muted">Not a git repository.</li> : null}
						</ul>
					</section>
					<section>
						<h2 className="font-condensed text-xs uppercase tracking-[0.2em] text-muted">
							Uncommitted changes {git ? `· ${Object.keys(git.files).length}` : ""}
						</h2>
						<ul className="mt-3 space-y-1">
							{changed.map(([path, letter]) => (
								<li key={path}>
									<button
										type="button"
										onClick={() =>
											void useEditor.getState().open(workspace.id, path.replace(/\/$/, ""), {
												diff: letter === "M",
											})
										}
										disabled={path.endsWith("/")}
										className="flex w-full items-center gap-2 text-left text-[13px] hover:text-red"
									>
										<span className="w-3 font-mono text-[11px]" style={{ color: GIT_COLORS[letter] }}>
											{letter}
										</span>
										<span className="truncate">{path}</span>
									</button>
								</li>
							))}
							{git && changed.length === 0 ? <li className="font-mono text-xs text-muted">Clean.</li> : null}
						</ul>
					</section>
				</div>
			</div>
		</div>
	);
}

function WelcomeAction({
	label,
	keys,
	onClick,
}: {
	readonly label: string;
	readonly keys: string;
	readonly onClick: () => void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			onClick={onClick}
			className="cut-corner flex items-center gap-3 bg-surface px-4 py-2 font-condensed text-sm uppercase tracking-wider ring-1 ring-border transition-colors hover:ring-red/50"
		>
			{label}
			<span className="font-mono text-[10px] normal-case text-muted">{keys}</span>
		</button>
	);
}
