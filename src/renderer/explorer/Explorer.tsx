import { useEffect, useMemo, useRef, useState } from "react";
import {
	ChevronDown,
	ChevronRight,
	FilePlus2,
	FolderPlus,
	ListCollapse,
	RefreshCw,
} from "lucide-react";
import type { Workspace } from "../../main/settings/store.ts";
import type { DirEntry } from "../../main/workspace/files.ts";
import { gitLetterFor, useTree } from "../state/tree.ts";
import { useEditor } from "../state/editor.ts";
import { useUi, type MenuItem } from "../state/ui.ts";
import { FileIcon, GIT_COLORS } from "./FileIcon.tsx";
import { IconButton } from "../shell/IconButton.tsx";

/**
 * The workspace's files. Folders load when opened; a single click previews a
 * file, a double click keeps it open. Right-click for the rest — including
 * handing the file to the chat.
 */

type Pending = { readonly parent: string; readonly kind: "file" | "dir" } | { readonly rename: string };

export function Explorer({ workspace }: { readonly workspace: Workspace }): React.JSX.Element {
	const tree = useTree((s) => s.trees[workspace.id]);
	const loadDir = useTree((s) => s.loadDir);
	const refreshGit = useTree((s) => s.refreshGit);
	const collapseAll = useTree((s) => s.collapseAll);
	const [pending, setPending] = useState<Pending | null>(null);

	useEffect(() => {
		if (!tree?.dirs[""]) void loadDir(workspace.id, "");
		void refreshGit(workspace.id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspace.id]);

	const changes = tree?.git ? Object.keys(tree.git.files).length : 0;

	return (
		<section className="flex h-full min-h-0 flex-col">
			<header className="flex h-9 shrink-0 items-center justify-between pl-4 pr-1">
				<h2 className="truncate font-condensed text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
					{workspace.name}
					{changes > 0 ? <span className="ml-2 text-[#e2c08d]">{changes}</span> : null}
				</h2>
				<div className="flex">
					<IconButton label="New file" onClick={() => setPending({ parent: "", kind: "file" })}>
						<FilePlus2 size={14} />
					</IconButton>
					<IconButton label="New folder" onClick={() => setPending({ parent: "", kind: "dir" })}>
						<FolderPlus size={14} />
					</IconButton>
					<IconButton
						label="Refresh"
						onClick={() => {
							for (const dir of Object.keys(tree?.dirs ?? { "": 0 })) void loadDir(workspace.id, dir);
							void refreshGit(workspace.id);
						}}
					>
						<RefreshCw size={14} />
					</IconButton>
					<IconButton label="Collapse folders" onClick={() => collapseAll(workspace.id)}>
						<ListCollapse size={14} />
					</IconButton>
				</div>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-6" role="tree">
				<DirChildren
					workspace={workspace}
					dir=""
					depth={0}
					pending={pending}
					setPending={setPending}
				/>
			</div>
		</section>
	);
}

function DirChildren({
	workspace,
	dir,
	depth,
	pending,
	setPending,
}: {
	readonly workspace: Workspace;
	readonly dir: string;
	readonly depth: number;
	readonly pending: Pending | null;
	readonly setPending: (pending: Pending | null) => void;
}): React.JSX.Element | null {
	const state = useTree((s) => s.trees[workspace.id]?.dirs[dir]);
	if (!state || state.state === "loading") {
		return <p className="py-1 font-mono text-[10px] text-muted" style={{ paddingLeft: 20 + depth * 12 }}>…</p>;
	}
	if (state.state === "error") {
		return (
			<p className="py-1 font-mono text-[10px] text-red" style={{ paddingLeft: 20 + depth * 12 }}>
				{state.reason}
			</p>
		);
	}
	const creatingHere = pending && "parent" in pending && pending.parent === dir;
	return (
		<>
			{creatingHere ? (
				<NameInput
					depth={depth}
					kind={pending.kind}
					initial=""
					onDone={async (name) => {
						setPending(null);
						if (!name) return;
						const path = dir ? `${dir}/${name}` : name;
						const result = await window.teez.files.create(workspace.id, path, pending.kind);
						if (!result.ok) useUi.getState().toast(result.reason, "error");
						else if (pending.kind === "file") void useEditor.getState().open(workspace.id, path);
					}}
				/>
			) : null}
			{state.entries.map((entry) => (
				<Row
					key={entry.path}
					workspace={workspace}
					entry={entry}
					depth={depth}
					pending={pending}
					setPending={setPending}
				/>
			))}
		</>
	);
}

function Row({
	workspace,
	entry,
	depth,
	pending,
	setPending,
}: {
	readonly workspace: Workspace;
	readonly entry: DirEntry;
	readonly depth: number;
	readonly pending: Pending | null;
	readonly setPending: (pending: Pending | null) => void;
}): React.JSX.Element {
	const expanded = useTree((s) => !!s.trees[workspace.id]?.expanded[entry.path]);
	const selected = useTree((s) => s.trees[workspace.id]?.selected === entry.path);
	const git = useTree((s) => s.trees[workspace.id]?.git ?? null);
	const toggle = useTree((s) => s.toggle);
	const select = useTree((s) => s.select);
	const openFile = useEditor((s) => s.open);
	const activeFile = useEditor((s) => s.byWorkspace[workspace.id]?.active === entry.path);
	const letter = useMemo(() => gitLetterFor(git, entry.path, entry.kind), [git, entry.path, entry.kind]);
	const isDir = entry.kind === "dir";
	const renaming = pending && "rename" in pending && pending.rename === entry.path;

	const menu = (event: React.MouseEvent): void => {
		event.preventDefault();
		select(workspace.id, entry.path);
		const parent = isDir ? entry.path : entry.path.split("/").slice(0, -1).join("/");
		const items: MenuItem[] = [
			...(isDir
				? []
				: [
						{ label: "Open", onSelect: () => void openFile(workspace.id, entry.path) },
						...(letter && letter !== "U" && letter !== "A"
							? [{ label: "Open changes", onSelect: () => void openFile(workspace.id, entry.path, { diff: true }) }]
							: []),
					]),
			{
				label: "Ask the agent about this",
				hint: "@",
				onSelect: () => useUi.getState().insertIntoComposer(`@${entry.path} `),
			},
			{ separator: true },
			{ label: "New file here", onSelect: () => openParent(parent, "file") },
			{ label: "New folder here", onSelect: () => openParent(parent, "dir") },
			{ label: "Rename", onSelect: () => setPending({ rename: entry.path }) },
			{ label: "Copy path", onSelect: () => void navigator.clipboard.writeText(entry.path) },
			{ label: "Reveal in File Explorer", onSelect: () => void window.teez.workspaces.reveal(workspace.id, entry.path) },
			{ separator: true },
			{
				label: "Delete",
				danger: true,
				onSelect: async () => {
					const result = await window.teez.files.delete(workspace.id, entry.path);
					if (!result.ok && result.reason !== "cancelled") useUi.getState().toast(result.reason, "error");
					else if (result.ok) useEditor.getState().close(workspace.id, entry.path);
				},
			},
		];
		useUi.getState().openMenu(event.clientX, event.clientY, items);
	};

	const openParent = (parent: string, kind: "file" | "dir"): void => {
		if (parent && !useTree.getState().trees[workspace.id]?.expanded[parent]) toggle(workspace.id, parent);
		setPending({ parent, kind });
	};

	if (renaming) {
		return (
			<NameInput
				depth={depth}
				kind={entry.kind}
				initial={entry.name}
				onDone={async (name) => {
					setPending(null);
					if (!name || name === entry.name) return;
					const parent = entry.path.split("/").slice(0, -1).join("/");
					const to = parent ? `${parent}/${name}` : name;
					const result = await window.teez.files.rename(workspace.id, entry.path, to);
					if (!result.ok) useUi.getState().toast(result.reason, "error");
				}}
			/>
		);
	}

	return (
		<>
			<div
				role="treeitem"
				aria-expanded={isDir ? expanded : undefined}
				aria-selected={selected}
				tabIndex={-1}
				onClick={() => {
					select(workspace.id, entry.path);
					if (isDir) toggle(workspace.id, entry.path);
					else void openFile(workspace.id, entry.path, { preview: true });
				}}
				onDoubleClick={() => {
					if (!isDir) useEditor.getState().pin(workspace.id, entry.path);
				}}
				onContextMenu={menu}
				className={`group flex h-[22px] cursor-pointer select-none items-center gap-1.5 pr-2 text-[13px] ${
					selected || activeFile ? "bg-red/10" : "hover:bg-white/[0.03]"
				} ${entry.heavy ? "opacity-45" : ""}`}
				style={{ paddingLeft: 8 + depth * 12 }}
			>
				<span className="flex w-3 shrink-0 justify-center text-muted">
					{isDir ? expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
				</span>
				<FileIcon name={entry.name} kind={entry.kind} open={expanded} />
				<span
					className="min-w-0 flex-1 truncate"
					style={letter ? { color: GIT_COLORS[letter] } : undefined}
				>
					{entry.name}
				</span>
				{letter ? (
					<span className="font-mono text-[10px]" style={{ color: GIT_COLORS[letter] }}>
						{isDir ? "●" : letter}
					</span>
				) : null}
			</div>
			{isDir && expanded ? (
				<DirChildren
					workspace={workspace}
					dir={entry.path}
					depth={depth + 1}
					pending={pending}
					setPending={setPending}
				/>
			) : null}
		</>
	);
}

function NameInput({
	depth,
	kind,
	initial,
	onDone,
}: {
	readonly depth: number;
	readonly kind: "file" | "dir";
	readonly initial: string;
	readonly onDone: (name: string) => void;
}): React.JSX.Element {
	const [value, setValue] = useState(initial);
	const input = useRef<HTMLInputElement>(null);
	const finished = useRef(false);
	useEffect(() => {
		const element = input.current;
		if (!element) return;
		element.focus();
		const dot = initial.lastIndexOf(".");
		element.setSelectionRange(0, dot > 0 ? dot : initial.length);
	}, [initial]);
	const finish = (name: string): void => {
		if (finished.current) return;
		finished.current = true;
		onDone(name.trim());
	};
	return (
		<div className="flex h-[22px] items-center gap-1.5 pr-2" style={{ paddingLeft: 20 + depth * 12 }}>
			<FileIcon name={value || (kind === "dir" ? "folder" : "file")} kind={kind} />
			<input
				ref={input}
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") finish(value);
					if (event.key === "Escape") finish("");
				}}
				onBlur={() => finish(value)}
				className="min-w-0 flex-1 bg-bg px-1 font-mono text-[12px] text-text outline-none ring-1 ring-red/60"
				spellCheck={false}
			/>
		</div>
	);
}
