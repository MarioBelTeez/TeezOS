import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
	ChevronDown,
	ChevronRight,
	FileText,
	KeyRound,
	Loader2,
	RotateCcw,
	Search,
	Sparkles,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import { detectInput, type FeedItem, type FeedKind, type FeedStatus } from "../../shared/feed.ts";
import { ENGINE_LABEL } from "../../shared/feed-engine.ts";
import { filterHistory, mergeHistory, type HistoryEntry } from "../../shared/feed-history.ts";
import { Meter, useNow as useMinuteClock } from "../chat/UsageRails.tsx";
import { limitRows, weeklyWarning } from "../chat/usage-rails.ts";
import { useFeed } from "../state/feed.ts";
import { useUsage } from "../state/usage.ts";
import { useSettings } from "../state/settings.ts";
import { IconButton } from "../shell/IconButton.tsx";

/**
 * Feed the Brain: paste a link or drop a video or PDF, and a model with no
 * tools reads it while TeezAI writes the vault notes — a Source note,
 * concepts, maybe a skill draft. The queue runs in the main process; this
 * view adds to it, follows it, and offers what comes after: open the notes,
 * install or discard a draft. Each job commits and pushes its own files.
 * History lists everything ingested, searchable.
 */

const KINDS: readonly { readonly id: FeedKind; readonly label: string }[] = [
	{ id: "auto", label: "Auto" },
	{ id: "source", label: "Source" },
	{ id: "concept", label: "Concept" },
	{ id: "skill", label: "Skill" },
];

const STATUS_LABEL: Readonly<Record<FeedStatus, string>> = {
	queued: "Queued",
	reading: "Reading",
	writing: "Writing",
	done: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
};

const STATUS_TONE: Readonly<Record<FeedStatus, string>> = {
	queued: "text-muted ring-border",
	reading: "text-[#f5a524] ring-[#f5a524]/40",
	writing: "text-red-hot ring-red/50",
	done: "text-[#73c991] ring-[#73c991]/40",
	failed: "text-red ring-red/50",
	cancelled: "text-muted ring-border",
};

const isRunning = (item: FeedItem): boolean => item.status === "reading" || item.status === "writing";

/** How long the run took (or has taken so far), from its start; "—" for one that never started. */
function elapsed(item: FeedItem, now: number): string {
	if (item.startedAt === null) return "—";
	const seconds = Math.max(0, Math.round(((item.finishedAt ?? now) - item.startedAt) / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function FeedView(): React.JSX.Element {
	const items = useFeed((s) => s.items);
	const hasGroq = useFeed((s) => s.hasGroq);
	const vaultPath = useSettings((s) => s.settings?.vaultPath);

	useEffect(() => useFeed.getState().start(), []);
	// A review left open when the view closes would keep the browser page hidden with nothing to show.
	useEffect(() => () => useFeed.getState().cancelInstall(), []);

	// A job changing state (not each log line) may have written notes or used up a quota.
	const settled = items.map((item) => `${item.id}:${item.status}`).join(",");
	useEffect(() => {
		void useFeed.getState().refreshEngine();
		void useFeed.getState().refreshHistory();
	}, [settled]);

	const ordered = [...items].reverse();
	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<div className="mx-auto w-full max-w-4xl px-6 py-6">
				<p className="glow-text font-condensed text-xs uppercase tracking-[0.3em] text-red-hot">Videos · Articles · PDFs</p>
				<h1 className="glow-text font-display text-5xl tracking-wide">FEED THE BRAIN</h1>
				<p className="mt-1 text-[14px] text-[#d8cdd2]">
					A model reads it and TeezOS files it into TeezMind: a Source note, its concepts, and a skill draft when it teaches one.
					What it writes is committed and pushed by itself.
				</p>
				{!vaultPath ? (
					<p className="mt-4 bg-red/10 p-3 font-mono text-[12px] ring-1 ring-red/40">No vault found. Pin your TeezMind folder first.</p>
				) : null}
				<EngineBar />
				{hasGroq === false ? <GroqBanner /> : null}
				<Composer />
				<h2 className="mt-8 mb-2 font-condensed text-xs uppercase tracking-[0.3em] text-muted">Queue</h2>
				{ordered.length === 0 ? (
					<p className="font-mono text-xs text-muted">Nothing fed yet.</p>
				) : (
					<ul className="flex flex-col gap-2">
						{ordered.map((item) => (
							<ItemRow key={item.id} item={item} />
						))}
					</ul>
				)}
				<History />
			</div>
			<SkillReviewDialog />
		</div>
	);
}

/**
 * The confirm step before a skill draft goes live: its SKILL.md in full and
 * every file it holds. Cancel is the default (Escape, a click outside).
 */
function SkillReviewDialog(): React.JSX.Element | null {
	const review = useFeed((s) => s.review);
	const { confirmInstall, cancelInstall } = useFeed.getState();
	useEffect(() => {
		if (!review) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			cancelInstall();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [review, cancelInstall]);
	if (!review) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onMouseDown={cancelInstall}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={`Install the ${review.name} skill`}
				onMouseDown={(event) => event.stopPropagation()}
				className="glass flex max-h-full w-full max-w-3xl flex-col gap-3 border border-red/40 p-5 shadow-2xl shadow-black/60"
			>
				<h2 className="font-display text-2xl tracking-wide">INSTALL {review.name.toUpperCase()}?</h2>
				<p className="text-[13px] text-[#d8cdd2]">
					A feed job wrote this from content it read. Once installed, every Claude session in the vault can load it. Read it first.
				</p>
				<div>
					<p className="mb-1 font-condensed text-xs uppercase tracking-[0.2em] text-muted">Files ({review.files.length})</p>
					<ul className="max-h-24 overflow-auto bg-bg/70 p-2 font-mono text-[11px] ring-1 ring-border">
						{review.files.map((file) => (
							<li key={file}>{file}</li>
						))}
					</ul>
				</div>
				<div className="flex min-h-0 flex-1 flex-col">
					<p className="mb-1 font-condensed text-xs uppercase tracking-[0.2em] text-muted">SKILL.md</p>
					<pre className="min-h-24 flex-1 overflow-auto bg-bg/70 p-2 font-mono text-[11px] whitespace-pre-wrap text-[#d8cdd2] ring-1 ring-border">
						{review.skillMd}
					</pre>
				</div>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						autoFocus
						onClick={cancelInstall}
						className="bg-surface-2 px-4 py-1 font-condensed text-sm uppercase tracking-wider ring-1 ring-border hover:text-text"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => void confirmInstall()}
						className="btn-hot cut-corner px-5 py-1 font-condensed text-sm uppercase tracking-wider"
					>
						Install
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

/** The engine in use; Claude's 5-hour bar (and weekly warning) when it is Claude, else the last quota error. */
function EngineBar(): React.JSX.Element | null {
	const status = useFeed((s) => s.engine);
	const usage = useUsage((s) => s.usage);
	const rows = useMemo(() => (usage ? limitRows(usage) : []), [usage]);
	const weekly = useMemo(() => (usage ? weeklyWarning(usage, "claude", "") : null), [usage]);
	const now = useMinuteClock(usage !== null);
	if (!status) return null;
	const claude = status.engine === "claude";
	const keyless = !status.hasGemini && !status.hasGroq;
	return (
		<div className="glass mt-4 flex flex-col gap-2 px-4 py-3 ring-1 ring-border">
			<p className="font-mono text-[12px]">
				<span className="font-condensed text-xs uppercase tracking-[0.2em] text-muted">Engine </span>
				{ENGINE_LABEL[status.engine]}
				{status.model ? <span className="text-muted"> · {status.model}</span> : null}
			</p>
			{claude && rows.length > 0 ? (
				<div className="max-w-xs">
					{rows.map((r) => (
						<Meter key={r.label} label={r.label} window={r.window} now={now} size={r.size} />
					))}
					{weekly ? <p className="mt-1 truncate font-mono text-[10.5px] text-amber">{weekly}</p> : null}
				</div>
			) : null}
			{claude && rows.length === 0 ? <p className="font-mono text-[11px] text-muted">Claude's plan usage shows here once a Claude chat is open.</p> : null}
			{!claude && status.lastError ? <p className="font-mono text-[11px] text-amber">{status.lastError.message}</p> : null}
			{claude && keyless ? (
				<p className="font-mono text-[11px] text-muted">A free Gemini key (Settings, Feed) reads sources without using your Claude plan.</p>
			) : null}
		</div>
	);
}

const GROQ_DISMISSED = "teezai.feed.groqHintDismissed";

function readDismissed(): boolean {
	try {
		return localStorage.getItem(GROQ_DISMISSED) === "1";
	} catch {
		return false;
	}
}

/** A small, optional hint: the Groq key transcribes videos without subtitles. */
function GroqBanner(): React.JSX.Element | null {
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [open, setOpen] = useState(false);
	const [dismissed, setDismissed] = useState(readDismissed);
	if (dismissed) return null;
	const save = async (): Promise<void> => {
		setBusy(true);
		const ok = await useFeed.getState().setGroq(key.trim());
		setBusy(false);
		if (ok) setKey("");
	};
	const dismiss = (): void => {
		try {
			localStorage.setItem(GROQ_DISMISSED, "1");
		} catch {
			// The hint just comes back next time.
		}
		setDismissed(true);
	};
	return (
		<div className="mt-3 flex flex-wrap items-center gap-2 px-1 text-[12px] text-muted">
			<KeyRound size={12} className="shrink-0" />
			<span>Optional: a Groq key lets Feed transcribe videos without subtitles.</span>
			<button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-0.5 hover:text-text">
				{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				{open ? "Hide" : "Add key"}
			</button>
			<button type="button" onClick={dismiss} aria-label="Dismiss" title="Do not show this again" className="ml-auto hover:text-text">
				<X size={12} />
			</button>
			{open ? (
				<div className="flex w-full items-center gap-2">
					<input
						type="password"
						value={key}
						placeholder="Groq key (gsk_…)"
						aria-label="Groq key"
						maxLength={200}
						onChange={(event) => setKey(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && key.trim()) void save();
						}}
						className="w-52 bg-surface px-2 py-1 font-mono text-[12px] text-text outline-none ring-1 ring-border focus:glow"
					/>
					<button
						type="button"
						disabled={busy || !key.trim().startsWith("gsk_")}
						onClick={() => void save()}
						className="bg-surface-2 px-3 py-1 font-condensed text-xs uppercase tracking-wider ring-1 ring-border hover:text-red-hot disabled:opacity-40"
					>
						Save
					</button>
				</div>
			) : null}
		</div>
	);
}

function droppedSource(event: React.DragEvent): string {
	const file = event.dataTransfer.files[0];
	if (file) return window.teez.files.pathFor(file);
	const uri = event.dataTransfer.getData("text/uri-list").split(/\r?\n/).find((line) => line && !line.startsWith("#"));
	return uri ?? event.dataTransfer.getData("text/plain");
}

function Composer(): React.JSX.Element {
	const [source, setSource] = useState("");
	const [kind, setKind] = useState<FeedKind>("auto");
	const [note, setNote] = useState("");
	const [over, setOver] = useState(false);
	const [busy, setBusy] = useState(false);
	const input = detectInput(source);

	const submit = async (): Promise<void> => {
		if (!input || busy) return;
		setBusy(true);
		const ok = await useFeed.getState().add(source.trim(), kind, note.trim());
		setBusy(false);
		if (ok) {
			setSource("");
			setNote("");
		}
	};

	return (
		<div
			onDragOver={(event) => {
				event.preventDefault();
				setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(event) => {
				event.preventDefault();
				setOver(false);
				const dropped = droppedSource(event).trim();
				if (dropped) setSource(dropped);
			}}
			className={`glass mt-5 flex min-h-48 flex-col justify-center gap-4 border border-dashed px-6 py-8 transition-shadow ${over ? "glow border-red" : "border-border"}`}
		>
			<div className="flex items-center gap-3">
				<Upload size={20} className={over ? "glow-icon text-red-hot" : "text-muted"} />
				{/* What the input reads as sits inside the field, so the field lines up with the row below. */}
				<div className="relative min-w-0 flex-1">
					<input
						value={source}
						placeholder="Paste a link or drop a video/PDF"
						aria-label="Link or file"
						maxLength={2048}
						onChange={(event) => setSource(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void submit();
						}}
						className="w-full bg-surface py-2.5 pr-28 pl-3 font-mono text-[13px] text-text outline-none ring-1 ring-border focus:glow"
					/>
					<span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-[10px] uppercase text-muted">
						{source.trim() ? (input ? input.replace("-", " ") : "not readable") : ""}
					</span>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-3">
				<div role="radiogroup" aria-label="Kind" className="flex ring-1 ring-border">
					{KINDS.map((k) => (
						<button
							key={k.id}
							type="button"
							role="radio"
							aria-checked={kind === k.id}
							onClick={() => setKind(k.id)}
							className={`px-3 py-1 font-condensed text-xs uppercase tracking-wider ${kind === k.id ? "bg-red text-text" : "text-muted hover:text-text"}`}
						>
							{k.label}
						</button>
					))}
				</div>
				<input
					value={note}
					placeholder="Why you're saving this (optional)"
					aria-label="Note"
					maxLength={1000}
					onChange={(event) => setNote(event.target.value)}
					className="min-w-0 flex-1 bg-surface px-2 py-1 text-[13px] text-text outline-none ring-1 ring-border focus:glow"
				/>
				<button
					type="button"
					disabled={busy || !input}
					onClick={() => void submit()}
					className="btn-hot cut-corner flex items-center gap-2 px-6 py-1.5 font-condensed text-sm uppercase tracking-wider disabled:opacity-40"
				>
					{busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
					Feed
				</button>
			</div>
		</div>
	);
}

/** The time, ticking each second while `active`. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

function ItemRow({ item }: { readonly item: FeedItem }): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const running = isRunning(item);
	const now = useNow(running);
	const { retry, cancel, remove } = window.teez.feed;

	return (
		<li className="glass ring-1 ring-border">
			<div className="flex items-center gap-3 px-3 py-2">
				<IconButton label={open ? "Hide the log" : "Show the log"} onClick={() => setOpen(!open)}>
					{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				</IconButton>
				<span className={`flex w-24 shrink-0 items-center gap-1.5 px-2 py-0.5 font-mono text-[10px] uppercase ring-1 ${STATUS_TONE[item.status]}`}>
					{running ? <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-current" /> : null}
					{STATUS_LABEL[item.status]}
				</span>
				<div className="min-w-0 flex-1">
					<p className="truncate text-[14px]">{item.title || item.source}</p>
					<p className="truncate font-mono text-[10px] text-muted">
						{item.input.replace("-", " ")} · {item.kind}
						{item.title ? ` · ${item.source}` : ""}
						{item.note ? ` · “${item.note}”` : ""}
					</p>
				</div>
				<span className="font-mono text-[11px] text-muted">{elapsed(item, now)}</span>
				{item.status === "queued" || running ? (
					<IconButton label="Cancel" onClick={() => void cancel(item.id)}>
						<X size={14} />
					</IconButton>
				) : null}
				{item.status === "failed" || item.status === "cancelled" ? (
					<IconButton label="Retry" onClick={() => void retry(item.id)}>
						<RotateCcw size={14} />
					</IconButton>
				) : null}
				{!running ? (
					<IconButton label="Remove from the list" onClick={() => void remove(item.id)}>
						<Trash2 size={14} />
					</IconButton>
				) : null}
			</div>
			{item.error ? <p className="px-11 pb-2 font-mono text-[11px] text-red-hot">{item.error}</p> : null}
			{item.status === "done" ? <Results item={item} /> : null}
			{open ? (
				<pre className="mx-3 mb-3 max-h-64 overflow-auto bg-bg/70 p-2 font-mono text-[11px] whitespace-pre-wrap text-[#d8cdd2] ring-1 ring-border">
					{item.log.length ? item.log.join("\n") : "No output yet."}
				</pre>
			) : null}
		</li>
	);
}

function Results({ item }: { readonly item: FeedItem }): React.JSX.Element {
	const drafts = useFeed((s) => s.drafts);
	const { openNote, install, discard } = useFeed.getState();

	return (
		<div className="flex flex-col gap-2 border-t border-border px-11 py-2">
			{item.changed.length === 0 ? (
				<p className="font-mono text-[11px] text-muted">No files changed.</p>
			) : (
				<ul className="flex flex-col gap-0.5">
					{item.changed.map((path) => (
						<li key={path}>
							{path.endsWith(".md") ? (
								<button
									type="button"
									onClick={() => void openNote(path)}
									className="flex items-center gap-1.5 text-left font-mono text-[12px] hover:text-red-hot"
								>
									<FileText size={12} className="shrink-0 text-muted" />
									{path}
								</button>
							) : (
								<span className="font-mono text-[12px] text-muted">{path}</span>
							)}
						</li>
					))}
				</ul>
			)}
			{item.drafts.map((name) => (
				<div key={name} className="flex items-center gap-2 font-mono text-[12px]">
					<Sparkles size={12} className="text-red-hot" />
					<span>skill draft: {name}</span>
					{drafts[name] ? (
						<span className="text-muted">({drafts[name]})</span>
					) : (
						<>
							<button type="button" onClick={() => void install(name)} className="ml-2 px-2 ring-1 ring-border hover:text-red-hot">
								Install
							</button>
							<button type="button" onClick={() => void discard(name)} className="px-2 text-muted ring-1 ring-border hover:text-text">
								Discard
							</button>
						</>
					)}
				</div>
			))}
		</div>
	);
}

const date = (ms: number): string => {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Everything ingested, newest first: finished jobs plus Source notes the vault holds from the feed. Searchable. */
function History(): React.JSX.Element {
	const items = useFeed((s) => s.items);
	const vaultNotes = useFeed((s) => s.vaultNotes);
	const [query, setQuery] = useState("");
	const entries = useMemo(() => mergeHistory(items, vaultNotes), [items, vaultNotes]);
	const shown = useMemo(() => filterHistory(entries, query), [entries, query]);
	return (
		<section aria-label="History" className="mt-8 pb-8">
			<div className="mb-2 flex items-center gap-3">
				<h2 className="font-condensed text-xs uppercase tracking-[0.3em] text-muted">History</h2>
				<span className="font-mono text-[10px] text-muted">{query.trim() ? `${shown.length} of ${entries.length}` : entries.length}</span>
				<div className="relative ml-auto w-64 max-w-full">
					<Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted" />
					<input
						value={query}
						placeholder="Search history"
						aria-label="Search history"
						maxLength={200}
						onChange={(event) => setQuery(event.target.value)}
						className="w-full bg-surface py-1 pr-2 pl-7 font-mono text-[11px] text-text outline-none ring-1 ring-border focus:glow"
					/>
				</div>
			</div>
			{shown.length === 0 ? (
				<p className="font-mono text-xs text-muted">{entries.length === 0 ? "Nothing ingested yet." : "Nothing matches."}</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{shown.map((entry) => (
						<HistoryRow key={entry.key} entry={entry} />
					))}
				</ul>
			)}
		</section>
	);
}

function HistoryRow({ entry }: { readonly entry: HistoryEntry }): React.JSX.Element {
	const openNote = useFeed.getState().openNote;
	const first = entry.notes[0];
	const web = /^https?:\/\//i.test(entry.source);
	return (
		<li className="glass flex items-start gap-3 px-3 py-2 ring-1 ring-border">
			<span className="w-20 shrink-0 pt-0.5 font-mono text-[11px] text-muted">{date(entry.date)}</span>
			<div className="min-w-0 flex-1">
				{first ? (
					<button type="button" onClick={() => void openNote(first)} className="block max-w-full truncate text-left text-[14px] hover:text-red-hot" title="Open in Brain">
						{entry.title}
					</button>
				) : (
					<p className="truncate text-[14px]">{entry.title}</p>
				)}
				<p className="truncate font-mono text-[10px] text-muted">
					{entry.kind || "note"}
					{entry.source ? " · " : ""}
					{web ? (
						<a href={entry.source} target="_blank" rel="noreferrer" className="hover:text-text">
							{entry.source}
						</a>
					) : (
						entry.source
					)}
				</p>
				{entry.notes.length > 1 ? (
					<p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
						{entry.notes.slice(1).map((path) => (
							<button key={path} type="button" onClick={() => void openNote(path)} className="font-mono text-[10px] text-muted hover:text-red-hot">
								{path.replace(/^(brain\/concepts|thinking\/skill-drafts|reference\/sources)\//, "")}
							</button>
						))}
					</p>
				) : null}
			</div>
		</li>
	);
}
