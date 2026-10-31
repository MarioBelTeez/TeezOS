import { useEffect, useState, type ReactNode } from "react";
import shortcutGuide from "../../../shortcut/README.md?raw";
import type { FeedKind, FeedStatus } from "../../../../src/shared/feed.ts";
import { postJson } from "../api.ts";
import { feedBody, feedBusy } from "../feed-input.ts";
import { Markdown } from "../components/Markdown.tsx";
import { useResource } from "../components/hooks.ts";
import { Dot, Empty, ErrorLine, IconButton, Panel, ScreenHeader, SectionTitle, Sheet } from "../components/ui.tsx";
import { ago } from "../format.ts";

/**
 * Feed the brain: a link or some text, a kind, and the queue with each
 * item's status. The server reads and files it in the background; the list
 * refreshes while anything is still being worked on. Recent captures (saved
 * from chats) are listed underneath, with the ones not synced yet marked.
 */

type FeedItem = { id: string; source: string; status: FeedStatus; title: string; error: string; createdAt: number };
type Capture = { path: string; title: string; date: string; synced: boolean };

const KINDS: readonly { readonly id: FeedKind; readonly label: string }[] = [
	{ id: "auto", label: "Auto" },
	{ id: "source", label: "Source" },
	{ id: "skill", label: "Skill" },
];

const STATUS: Readonly<Record<FeedStatus, { label: string; tone: "ok" | "bad" | "idle" | "live" }>> = {
	queued: { label: "Queued", tone: "idle" },
	reading: { label: "Reading", tone: "live" },
	writing: { label: "Writing", tone: "live" },
	done: { label: "Done", tone: "ok" },
	failed: { label: "Failed", tone: "bad" },
	cancelled: { label: "Cancelled", tone: "idle" },
};

const BUSY_POLL_MS = 4000;
const IDLE_POLL_MS = 30_000;

export function Feed({ active }: { active: boolean }): ReactNode {
	const [input, setInput] = useState("");
	const [kind, setKind] = useState<FeedKind>("auto");
	const [sending, setSending] = useState(false);
	const [failure, setFailure] = useState<{ text: string; offline: boolean } | null>(null);
	const [guide, setGuide] = useState(false);
	const [busy, setBusy] = useState(false);
	// Polls only while something is queued or being worked on; a new item turns it back on (submit reloads).
	const feed = useResource<{ items: FeedItem[] }>("/api/feed", active, busy ? BUSY_POLL_MS : 0);
	const captures = useResource<Capture[]>("/api/captures", active, IDLE_POLL_MS);
	const items = feed.data?.items ?? [];
	useEffect(() => setBusy(feedBusy(feed.data?.items ?? [])), [feed.data]);

	const submit = async (): Promise<void> => {
		if (input.trim() === "") return;
		setSending(true);
		const result = await postJson<{ id: string }>("/api/feed", feedBody(input, kind));
		setSending(false);
		if (result.ok) {
			setInput("");
			setFailure(null);
			void feed.reload();
		} else setFailure({ text: result.error, offline: result.offline });
	};

	return (
		<section className="flex h-full flex-col">
			<ScreenHeader
				title="Feed"
				right={
					<IconButton label="Shortcut instructions" onClick={() => setGuide(true)}>
						Shortcut
					</IconButton>
				}
			/>
			<div className="scroll-y safe-x min-h-0 flex-1 pb-6">
				<form
					className="mt-3 flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<textarea className="input min-h-24 resize-none" value={input} placeholder="Paste a link, or some text" aria-label="Link or text" onChange={(event) => setInput(event.target.value)} />
					<div className="flex gap-2">
						<div role="radiogroup" aria-label="Kind" className="flex flex-1 gap-1">
							{KINDS.map((option) => (
								<button
									key={option.id}
									type="button"
									role="radio"
									aria-checked={kind === option.id}
									onClick={() => setKind(option.id)}
									className={`h-11 flex-1 border text-[17px] ${kind === option.id ? "glow border-red text-text" : "border-border text-muted"}`}
								>
									{option.label}
								</button>
							))}
						</div>
						<button type="submit" disabled={sending || input.trim() === ""} className="btn-hot h-11 min-w-20 px-3 font-display text-[20px] tracking-wider">
							{sending ? "…" : "Feed"}
						</button>
					</div>
				</form>
				{failure ? <ErrorLine text={failure.text} offline={failure.offline} /> : null}
				{feed.error ? <ErrorLine text={feed.error.text} offline={feed.error.offline} /> : null}

				<SectionTitle>Queue</SectionTitle>
				{feed.data && items.length === 0 ? <Empty>Nothing fed yet. Share a link from Safari with the Shortcut, or paste one above.</Empty> : null}
				<ul className="flex flex-col gap-2">
					{items.map((item) => (
						<li key={item.id}>
							<Panel>
								<div className="flex items-center gap-2">
									<Dot tone={STATUS[item.status].tone} />
									<span className="font-mono text-[12px] text-muted uppercase">{STATUS[item.status].label}</span>
									<span className="ml-auto font-mono text-[12px] text-muted">{ago(item.createdAt)}</span>
								</div>
								<p className="mt-1 text-[17px] break-words">{item.title || item.source}</p>
								{item.title ? <p className="truncate font-mono text-[12px] text-muted">{item.source}</p> : null}
								{item.error ? <p className="mt-1 text-[15px] text-[#ff8da0]">{item.error}</p> : null}
							</Panel>
						</li>
					))}
				</ul>

				<SectionTitle>Saved from chats</SectionTitle>
				{captures.error ? <ErrorLine text={captures.error.text} offline={captures.error.offline} /> : null}
				{captures.data && captures.data.length === 0 ? <Empty>No captures yet.</Empty> : null}
				<ul className="flex flex-col gap-1">
					{[...(captures.data ?? [])].reverse().map((capture) => (
						<li key={capture.path} className="flex items-baseline gap-2 border-b border-border py-2">
							<span className="flex-1 text-[16px]">{capture.title}</span>
							<span className={`font-mono text-[12px] ${capture.synced ? "text-muted" : "text-amber"}`}>{capture.synced ? capture.date : "not synced yet"}</span>
						</li>
					))}
				</ul>
			</div>
			{guide ? (
				<Sheet title="Share Sheet Shortcut" onClose={() => setGuide(false)}>
					<Markdown text={shortcutGuide} />
				</Sheet>
			) : null}
		</section>
	);
}
