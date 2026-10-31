import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import Markdown from "react-markdown";
import { safeMarkdownUrl } from "../../shared/safe-url.ts";
import remarkGfm from "remark-gfm";
import {
	ArrowLeft,
	ArrowRight,
	ChevronDown,
	ChevronRight,
	ExternalLink,
	FileText,
	GitFork,
	Link2,
	MessageSquare,
	Network,
	Pencil,
	Search,
	Sparkles,
} from "lucide-react";
import type { NoteMeta } from "../../main/brain/vault.ts";
import type { BrainHit } from "../../main/brain/search.ts";
import { useBrain } from "../state/brain.ts";
import { folderColor } from "../brain/graph-math.ts";
import { useSettings, vaultWorkspaceIdOf } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { useEditor } from "../state/editor.ts";
import { remarkObsidian, WIKILINK_PREFIX } from "../brain/remark-obsidian.ts";
import { Graph } from "../brain/Graph.tsx";
import { ChatPanel } from "../chat/ChatPanel.tsx";
import { IconButton } from "../shell/IconButton.tsx";
import { openWorkspace, revealPanel } from "../shell/dock-actions.ts";

/**
 * Brain: the TeezMind vault as a reader. Notes render with working wikilinks
 * and callouts; the side panel shows who links here, the local graph, and a
 * chat that runs in the vault — Claude or Antigravity, switchable as anywhere.
 */

const urlTransform = (url: string, key: string): string => (url.startsWith(WIKILINK_PREFIX) ? url : safeMarkdownUrl(url, key));

export function BrainView(): React.JSX.Element {
	const index = useBrain((s) => s.index);
	const mode = useBrain((s) => s.mode);
	const current = useBrain((s) => s.current);
	const settings = useSettings((s) => s.settings);
	// Shallow: every settings broadcast brings a new object; the graph only re-tunes when a value changed.
	const physics = useSettings(useShallow((s) => s.settings?.modules.brain));

	useEffect(() => {
		if (!useBrain.getState().index) void useBrain.getState().load();
	}, []);

	if (!settings?.vaultPath) {
		return (
			<div className="flex flex-1 items-center justify-center font-mono text-xs text-muted">
				No vault found. Pin your TeezMind folder and it becomes the Brain.
			</div>
		);
	}

	return (
		<div data-nav-area="brain" className="flex min-h-0 min-w-0 flex-1">
			<Navigator />
			<div className="flex min-w-0 flex-1 flex-col">
				<ReaderBar />
				<div className="relative min-h-0 flex-1">
					{mode === "graph" && index ? (
						<div className="absolute inset-0">
							<Graph index={index} current={current} onOpen={(path) => void useBrain.getState().open(path)} physics={physics} />
							<Legend />
						</div>
					) : (
						<Reader />
					)}
				</div>
			</div>
			<SidePanel />
		</div>
	);
}

function Navigator(): React.JSX.Element {
	const index = useBrain((s) => s.index);
	const current = useBrain((s) => s.current);
	const open = useBrain((s) => s.open);
	const [query, setQuery] = useState("");
	const [deep, setDeep] = useState(false);
	const [results, setResults] = useState<{ hits: BrainHit[]; engine: string } | null>(null);
	const [searching, setSearching] = useState(false);
	const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({ "work/archive": true });
	const request = useRef(0);

	useEffect(() => {
		const id = (request.current += 1);
		if (!query.trim()) {
			setResults(null);
			setSearching(false);
			return;
		}
		const timer = setTimeout(() => {
			setSearching(true);
			void window.teez.brain.search(query, deep).then((r) => {
				if (id !== request.current) return;
				setResults(r);
				setSearching(false);
			});
		}, deep ? 600 : 250);
		return () => clearTimeout(timer);
	}, [query, deep]);

	const folders = useMemo(() => {
		const map = new Map<string, NoteMeta[]>();
		for (const note of index?.notes ?? []) map.set(note.folder, [...(map.get(note.folder) ?? []), note]);
		return [...map.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
	}, [index]);

	const recent = useMemo(() => [...(index?.notes ?? [])].sort((a, b) => b.modified - a.modified).slice(0, 6), [index]);

	return (
		<aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
			<div className="border-b border-border p-2">
				<div className="flex items-center gap-1 bg-bg ring-1 ring-border focus-within:glow">
					<Search size={13} className="ml-2 shrink-0 text-muted" />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={deep ? "Ask the vault (QMD deep)…" : "Search the vault…"}
						className="min-w-0 flex-1 bg-transparent px-1.5 py-1.5 font-mono text-[11.5px] text-text outline-none"
					/>
					<IconButton label={deep ? "Deep search on (QMD hybrid, slower)" : "Deep search off (keywords)"} active={deep} onClick={() => setDeep((d) => !d)}>
						<Sparkles size={13} />
					</IconButton>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto py-1">
				{results || searching ? (
					<>
						<p className="px-3 py-1 font-mono text-[10px] text-muted">
							{searching ? "searching…" : `${results?.hits.length ?? 0} results · ${results?.engine}`}
						</p>
						{results?.hits.map((hit) => (
							<button
								key={`${hit.path}:${hit.line}`}
								type="button"
								onClick={() => void open(hit.path)}
								className={`block w-full border-l-2 px-3 py-1.5 text-left hover:bg-white/[0.03] ${current === hit.path ? "border-red" : "border-transparent"}`}
							>
								<p className="truncate text-[13px]">{hit.title}</p>
								<p className="line-clamp-2 font-mono text-[10px] text-muted">{hit.snippet}</p>
							</button>
						))}
					</>
				) : (
					<>
						<p className="px-3 pt-1 pb-0.5 font-condensed text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">Recent</p>
						{recent.map((note) => (
							<NoteRow key={`recent-${note.path}`} note={note} active={current === note.path} onOpen={open} />
						))}
						{folders.map(([folder, notes]) => {
							const isCollapsed = collapsed[folder] ?? false;
							return (
								<div key={folder || "root"} className="mt-1">
									<button
										type="button"
										onClick={() => setCollapsed({ ...collapsed, [folder]: !isCollapsed })}
										className="flex w-full items-center gap-1 px-2 py-0.5 font-condensed text-[11px] font-semibold uppercase tracking-[0.15em] text-muted hover:text-text"
									>
										{isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
										<span className="h-2 w-2 shrink-0" style={{ background: folderColor(folder ? `${folder}/x` : "x") }} />
										<span className="truncate">{folder || "vault root"}</span>
										<span className="ml-auto font-mono text-[9px]">{notes.length}</span>
									</button>
									{isCollapsed
										? null
										: [...notes]
												.sort((a, b) => a.title.localeCompare(b.title))
												.map((note) => <NoteRow key={note.path} note={note} active={current === note.path} onOpen={open} indent />)}
								</div>
							);
						})}
					</>
				)}
			</div>
			{index ? (
				<p className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted">
					{index.notes.length} notes · {index.edges.length} links
					{index.unresolved.length ? ` · ${index.unresolved.length} unresolved` : ""}
				</p>
			) : null}
		</aside>
	);
}

function NoteRow({
	note,
	active,
	onOpen,
	indent = false,
}: {
	readonly note: NoteMeta;
	readonly active: boolean;
	readonly onOpen: (path: string) => Promise<void>;
	readonly indent?: boolean;
}): React.JSX.Element {
	return (
		<button
			type="button"
			onClick={() => void onOpen(note.path)}
			title={note.description || note.path}
			className={`flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[12.5px] hover:bg-white/[0.03] ${
				active ? "bg-red/10 text-text" : "text-[#d8cdd2]"
			}`}
			style={{ paddingLeft: indent ? 26 : 12 }}
		>
			<FileText size={12} className="shrink-0 text-muted" />
			<span className="truncate">{note.title}</span>
			{note.backlinks > 0 ? <span className="ml-auto font-mono text-[9px] text-muted">{note.backlinks}</span> : null}
		</button>
	);
}

function vaultWorkspaceId(): string | null {
	return vaultWorkspaceIdOf(useSettings.getState().settings);
}

function ReaderBar(): React.JSX.Element {
	const note = useBrain((s) => s.note);
	const mode = useBrain((s) => s.mode);
	const canBack = useBrain((s) => s.canBack);
	const canForward = useBrain((s) => s.canForward);
	const { back, forward, setMode } = useBrain.getState();

	return (
		<div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
			<IconButton label="Back" disabled={!canBack} onClick={back}>
				<ArrowLeft size={15} />
			</IconButton>
			<IconButton label="Forward" disabled={!canForward} onClick={forward}>
				<ArrowRight size={15} />
			</IconButton>
			<span className="ml-1 truncate font-mono text-[11px] text-muted">{mode === "graph" ? "Graph of the whole vault" : note?.meta.path}</span>
			<div className="flex-1" />
			{note && mode === "note" ? (
				<>
					<IconButton
						label="Edit in the Code view"
						onClick={() => {
							const workspaceId = vaultWorkspaceId();
							if (!workspaceId) return;
							openWorkspace(workspaceId);
							void useEditor.getState().open(workspaceId, note.meta.path);
							revealPanel("editor");
						}}
					>
						<Pencil size={14} />
					</IconButton>
					<IconButton label="Open in Obsidian" onClick={() => void window.teez.brain.openInObsidian(note.meta.path)}>
						<ExternalLink size={14} />
					</IconButton>
				</>
			) : null}
			<button
				type="button"
				onClick={() => setMode(mode === "graph" ? "note" : "graph")}
				className={`ml-1 flex h-6 items-center gap-1.5 px-2 font-condensed text-[11px] font-semibold uppercase tracking-wider ring-1 ${
					mode === "graph" ? "bg-red text-text ring-red" : "text-muted ring-border hover:text-text"
				}`}
			>
				<Network size={12} /> Graph
			</button>
		</div>
	);
}

function Reader(): React.JSX.Element {
	const note = useBrain((s) => s.note);
	const openLink = useBrain((s) => s.openLink);
	const scroller = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (scroller.current) scroller.current.scrollTop = 0;
	}, [note?.meta.path]);

	if (!note) return <p className="p-10 font-mono text-xs text-muted">Pick a note.</p>;
	const fm = note.frontmatter;
	const chips = ["date", "status", "quarter", "project", "team", "cycle", "severity"]
		.map((key) => [key, fm[key]] as const)
		.filter(([, value]) => typeof value === "string" || typeof value === "number" || value instanceof Date)
		.map(([key, value]) => [key, value instanceof Date ? value.toISOString().slice(0, 10) : String(value)] as const);

	return (
		<div ref={scroller} className="h-full overflow-y-auto">
			<article className="mx-auto max-w-[860px] px-10 pt-8 pb-24">
				<p className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: folderColor(note.meta.path) }}>
					{note.meta.folder || "vault"}
				</p>
				<h1 className="mt-1 font-display text-5xl leading-[0.95] tracking-wide">{note.meta.title}</h1>
				{note.meta.description ? <p className="mt-3 text-[15px] leading-snug text-[#d8cdd2]">{note.meta.description}</p> : null}
				<div className="mt-3 flex flex-wrap gap-1.5">
					{chips.map(([key, value]) => (
						<span key={key} className="bg-surface px-2 py-0.5 font-mono text-[10px] ring-1 ring-border">
							<span className="text-muted">{key}</span> {value}
						</span>
					))}
					{note.meta.tags.map((tag) => (
						<span key={tag} className="bg-red/10 px-2 py-0.5 font-mono text-[10px] text-[#ff8fa3] ring-1 ring-red/30">
							#{tag}
						</span>
					))}
				</div>
				<div className="prose-teez prose-note mt-6">
					<Markdown
						remarkPlugins={[remarkGfm, remarkObsidian]}
						urlTransform={urlTransform}
						components={{
							a: ({ href, children, className }) => {
								if (href?.startsWith(WIKILINK_PREFIX)) {
									let target: string;
									try {
										target = decodeURIComponent(href.slice(WIKILINK_PREFIX.length));
									} catch {
										// A malformed escape in a note must not blank the whole window.
										target = href.slice(WIKILINK_PREFIX.length);
									}
									const bare = target.split("#")[0]?.trim() ?? "";
									const outgoing = note.outgoing.find((o) => o.target === bare);
									const unresolved = outgoing?.kind === "missing";
									return (
										<a
											href="#"
											className={`${className ?? "wikilink"}${unresolved ? " unresolved" : ""}`}
											title={outgoing?.path ?? target}
											onClick={(event) => {
												event.preventDefault();
												void openLink(target).then((ok) => {
													if (!ok) useUi.getState().toast(`No note called "${bare}" yet.`);
												});
											}}
										>
											{children}
										</a>
									);
								}
								return (
									<a href={href} target="_blank" rel="noreferrer">
										{children}
									</a>
								);
							},
						}}
					>
						{note.body}
					</Markdown>
				</div>
			</article>
		</div>
	);
}

function SidePanel(): React.JSX.Element {
	const [tab, setTab] = useState<"links" | "graph" | "chat">("links");
	const note = useBrain((s) => s.note);
	const index = useBrain((s) => s.index);
	const open = useBrain((s) => s.open);
	const width = useSettings((s) => s.settings?.layout.rightWidth ?? 420);
	const workspaces = useSettings((s) => s.settings?.workspaces);
	const vaultPath = useSettings((s) => s.settings?.vaultPath);
	// Shallow: every settings broadcast brings a new object; the graph only re-tunes when a value changed.
	const physics = useSettings(useShallow((s) => s.settings?.modules.brain));
	const workspace = useMemo(() => {
		const id = vaultWorkspaceId();
		return workspaces?.find((w) => w.id === id) ?? null;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspaces, vaultPath]);
	const insert = useUi((s) => s.composerInsert);

	// Asking about a note switches to the chat (only for a new request, not
	// one left over from before this panel mounted).
	useEffect(() => {
		if (insert) setTab("chat");
	}, [insert?.nonce]);

	const tabs = [
		{ id: "links" as const, label: "Links", icon: Link2 },
		{ id: "graph" as const, label: "Local graph", icon: GitFork },
		{ id: "chat" as const, label: "Chat", icon: MessageSquare },
	];

	return (
		<aside className="flex shrink-0 flex-col border-l border-border bg-bg" style={{ width }}>
			<div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-2">
				{tabs.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						type="button"
						onClick={() => setTab(id)}
						className={`relative flex h-9 items-center gap-1.5 px-2.5 font-condensed text-[11px] font-semibold uppercase tracking-wider ${
							tab === id ? "text-text" : "text-muted hover:text-text"
						}`}
					>
						<Icon size={13} />
						{label}
						{tab === id ? <span className="absolute inset-x-2 bottom-0 h-[2px] bg-red" /> : null}
					</button>
				))}
				<div className="flex-1" />
				{note ? (
					<IconButton label="Ask the agent about this note" onClick={() => useUi.getState().insertIntoComposer(`@${note.meta.path} `)}>
						<Sparkles size={14} />
					</IconButton>
				) : null}
			</div>
			<div className="min-h-0 flex-1">
				{tab === "links" ? (
					<div className="h-full overflow-y-auto px-3 py-3">
						<h3 className="font-condensed text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
							Linked from · {note?.backlinks.length ?? 0}
						</h3>
						<ul className="mt-2 space-y-2">
							{note?.backlinks.map((link) => (
								<li key={link.path}>
									<button type="button" onClick={() => void open(link.path)} className="block w-full text-left">
										<span className="flex items-center gap-1.5 text-[13px] hover:text-red">
											<span className="h-1.5 w-1.5 shrink-0" style={{ background: folderColor(link.path) }} />
											{link.title}
										</span>
										{link.context ? <span className="mt-0.5 line-clamp-2 block font-mono text-[10px] text-muted">{link.context}</span> : null}
									</button>
								</li>
							))}
						</ul>
						<h3 className="mt-6 font-condensed text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
							Links to · {note?.outgoing.length ?? 0}
						</h3>
						<ul className="mt-2 space-y-1">
							{note?.outgoing.map((link) => (
								<li key={link.target}>
									{link.path ? (
										<button
											type="button"
											onClick={() => void (link.kind === "file" ? window.teez.brain.openInObsidian(link.path ?? "") : open(link.path ?? ""))}
											title={link.kind === "file" ? `${link.path} — opens in Obsidian` : (link.path ?? "")}
											className={`flex items-center gap-1.5 text-left text-[13px] hover:text-red ${link.kind === "file" ? "text-muted" : ""}`}
										>
											<span className="h-1.5 w-1.5 shrink-0" style={{ background: link.kind === "file" ? "transparent" : folderColor(link.path), outline: link.kind === "file" ? "1px solid currentColor" : undefined }} />
											{link.target}
										</button>
									) : (
										<span className="text-[13px] text-muted line-through decoration-red/60" title="No note with this name">
											{link.target}
										</span>
									)}
								</li>
							))}
						</ul>
					</div>
				) : null}
				{tab === "graph" && index && note ? (
					<Graph index={index} focus={note.meta.path} current={note.meta.path} onOpen={(path) => void open(path)} compact physics={physics} />
				) : null}
				{tab === "chat" ? (
					workspace ? (
						<ChatPanel
							workspace={workspace}
							quickPrompts={[
								{ label: "Standup", text: "/om-standup" },
								{ label: "Wrap up", text: "/om-wrap-up" },
								{ label: "Weekly", text: "/om-weekly" },
								{ label: "Vault audit", text: "/om-vault-audit" },
							]}
						/>
					) : (
						<p className="p-4 font-mono text-[11px] text-muted">Pin the vault folder to chat with it here.</p>
					)
				) : null}
			</div>
		</aside>
	);
}

function Legend(): React.JSX.Element {
	const items = [
		["brain", "brain/x"],
		["work", "work/x"],
		["org", "org/x"],
		["perf", "perf/x"],
		["reference", "reference/x"],
		["thinking", "thinking/x"],
		["root", "x"],
	] as const;
	return (
		<div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-3 bg-bg/80 px-3 py-1.5 font-mono text-[10px] text-muted">
			{items.map(([label, sample]) => (
				<span key={label} className="flex items-center gap-1.5">
					<span className="h-2 w-2 rounded-full" style={{ background: folderColor(sample) }} />
					{label}
				</span>
			))}
			<span>· size = backlinks · drag, scroll to zoom</span>
		</div>
	);
}
