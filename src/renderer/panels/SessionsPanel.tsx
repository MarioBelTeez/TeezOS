import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Workspace } from "../../main/settings/store.ts";
import type { SessionSummary } from "../../main/sessions/history.ts";
import { useUi } from "../state/ui.ts";
import { IconButton } from "../shell/IconButton.tsx";
import { SESSIONS_CHANGED, copyText, deletePastSession, openPastSession } from "../chat/session-actions.ts";

/**
 * Every Claude session run in this folder, wherever it was started. Opening
 * one shows the conversation and continues it — the agent picks up with the
 * full context, as `claude --resume` would.
 */

function ago(timestamp: number): string {
	const minutes = Math.round((Date.now() - timestamp) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString();
}

export function SessionsPanel({ workspace }: { readonly workspace: Workspace }): React.JSX.Element {
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const [opening, setOpening] = useState<string | null>(null);
	const [filter, setFilter] = useState("");

	const load = (): void => {
		setSessions(null);
		void window.teez.sessions.list(workspace.id).then(setSessions);
	};
	useEffect(load, [workspace.id]);

	// A delete from anywhere (this list or a chat tab) drops the row without a reload.
	useEffect(() => {
		const onChange = (event: Event): void => {
			const detail = (event as CustomEvent<{ workspaceId: string; sessionId: string }>).detail;
			if (detail.workspaceId === workspace.id) setSessions((list) => list?.filter((s) => s.id !== detail.sessionId) ?? null);
		};
		window.addEventListener(SESSIONS_CHANGED, onChange);
		return () => window.removeEventListener(SESSIONS_CHANGED, onChange);
	}, [workspace.id]);

	const open = async (session: SessionSummary): Promise<void> => {
		setOpening(session.id);
		try {
			await openPastSession(workspace.id, session);
		} finally {
			setOpening(null);
		}
	};

	const menu = (event: React.MouseEvent, session: SessionSummary): void => {
		event.preventDefault();
		useUi.getState().openMenu(event.clientX, event.clientY, [
			{ label: "Open in a chat", disabled: opening !== null, onSelect: () => void open(session) },
			{ separator: true },
			{ label: "Copy title", onSelect: () => copyText(session.title, "Title") },
			{ label: "Copy session ID", onSelect: () => copyText(session.id, "Session ID") },
			{
				label: "Copy resume command",
				onSelect: () =>
					copyText(session.agent === "agy" ? `agy --conversation ${session.id}` : `claude --resume ${session.id}`, "Resume command"),
			},
			{ separator: true },
			{ label: "Refresh list", onSelect: load },
			{ label: "Delete session…", danger: true, onSelect: () => void deletePastSession(workspace.id, session.id, session.title, session.agent) },
		]);
	};

	const shown = (sessions ?? []).filter((s) => !filter || s.title.toLowerCase().includes(filter.toLowerCase()));

	return (
		<section className="flex h-full min-h-0 flex-col">
			<header className="flex h-9 shrink-0 items-center justify-between pl-4 pr-1">
				<h2 className="font-condensed text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
					Sessions {sessions ? `· ${sessions.length}` : ""}
				</h2>
				<IconButton label="Refresh" onClick={load}>
					<RefreshCw size={14} />
				</IconButton>
			</header>
			<div className="px-3 pb-2">
				<input
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
					placeholder="Filter…"
					className="w-full bg-bg px-2 py-1 font-mono text-[11px] text-text outline-none ring-1 ring-border focus:glow"
				/>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{sessions === null ? <p className="px-4 font-mono text-[11px] text-muted">Reading…</p> : null}
				{sessions?.length === 0 ? (
					<p className="px-4 font-mono text-[11px] leading-relaxed text-muted">
						No sessions have run in this folder yet.
					</p>
				) : null}
				{shown.map((session) => (
					<button
						key={`${session.agent}:${session.id}`}
						type="button"
						disabled={opening !== null}
						onClick={() => void open(session)}
						onContextMenu={(event) => menu(event, session)}
						className="block w-full border-l-2 border-transparent px-4 py-2 text-left hover:border-red hover:bg-white/[0.03] disabled:opacity-50"
					>
						<p className="line-clamp-2 text-[13px] leading-snug">{session.title}</p>
						<p className="mt-0.5 font-mono text-[10px] text-muted">
							<span className="mr-1.5 uppercase text-red/90">{session.agent}</span>
							{opening === session.id ? "opening…" : ago(session.modified)} · {Math.max(1, Math.round(session.size / 1024))} KB
						</p>
					</button>
				))}
			</div>
		</section>
	);
}
