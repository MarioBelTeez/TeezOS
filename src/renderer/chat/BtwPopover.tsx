import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { BtwEvent } from "../../main/agents/btw-service.ts";
import type { Chat } from "../state/chats.ts";
import { useUi } from "../state/ui.ts";
import { MarkdownText } from "./Cards.tsx";
import { ComposerPopover } from "./ComposerPopover.tsx";
import { agentName } from "./agent-options.ts";
import { buildHandover } from "./handover.ts";

/**
 * `/btw`: a side question about the chat that adds nothing to it. Claude
 * answers from a fork of the session; Antigravity from a fresh run given the
 * hand-over summary. The answer stays until the popover closes; closing it
 * mid-answer cancels the run.
 */

const MAX_QUESTION = 4000;

type Status = "idle" | "running" | "done" | "error";

export function BtwPopover({
	chat,
	anchor,
	initialQuestion,
	onClose,
}: {
	readonly chat: Chat;
	readonly anchor: React.RefObject<HTMLElement | null>;
	/** From "/btw <question>": asked as soon as the popover opens. */
	readonly initialQuestion: string;
	readonly onClose: () => void;
}): React.JSX.Element {
	const [question, setQuestion] = useState(initialQuestion);
	const [asked, setAsked] = useState("");
	const [answer, setAnswer] = useState("");
	const [status, setStatus] = useState<Status>("idle");
	const [error, setError] = useState("");
	const running = useRef<string | null>(null);
	/** Events that beat `ask`'s reply here; claimed once the id is known. */
	const early = useRef<BtwEvent[]>([]);
	/** Between sending a question and its id coming back. */
	const asking = useRef(false);
	const closed = useRef(false);

	const apply = useCallback((event: BtwEvent): void => {
		if (event.kind === "delta") {
			setAnswer((previous) => previous + event.text);
			return;
		}
		running.current = null;
		if (event.kind === "done") {
			setAnswer(event.text);
			setStatus("done");
		} else {
			setError(event.text);
			setStatus("error");
		}
	}, []);

	useEffect(() => {
		const off = window.teez.btw.onEvent((event) => {
			if (event.btwId === running.current) apply(event);
			else if (running.current === null && early.current.length < 200) early.current.push(event);
		});
		closed.current = false;
		return () => {
			off();
			closed.current = true;
			// Closing the popover ends a question still being answered.
			if (running.current) window.teez.btw.cancel(running.current);
			running.current = null;
		};
	}, [apply]);

	const ask = async (text: string): Promise<void> => {
		const trimmed = text.trim().slice(0, MAX_QUESTION);
		if (!trimmed || running.current || asking.current) return;
		// Antigravity cannot fork its conversation: it gets the gist instead.
		const handover = chat.agent === "agy" ? buildHandover(chat.cards, agentName(chat.agent), chat.title) : "";
		const sent = handover ? `${handover}\n\nSide question (answer it; change nothing): ${trimmed}` : trimmed;
		setAsked(trimmed);
		setAnswer("");
		setError("");
		setStatus("running");
		early.current = [];
		asking.current = true;
		const result = await window.teez.btw.ask(chat.chatId, sent).catch((reason: unknown) => ({ error: String(reason) }));
		asking.current = false;
		if (typeof result === "string" && closed.current) {
			// Closed while it was starting: nobody will read the answer.
			window.teez.btw.cancel(result);
			return;
		}
		if (typeof result !== "string") {
			setError(result.error);
			setStatus("error");
			return;
		}
		running.current = result;
		const waiting = early.current.filter((event) => event.btwId === result);
		early.current = [];
		for (const event of waiting) apply(event);
	};

	// "/btw <question>" asks straight away.
	const autoAsked = useRef(false);
	useEffect(() => {
		if (autoAsked.current || !initialQuestion.trim()) return;
		autoAsked.current = true;
		void ask(initialQuestion);
	});

	const cancel = (): void => {
		if (!running.current) return;
		window.teez.btw.cancel(running.current);
		running.current = null;
		setStatus(answer ? "done" : "idle");
	};

	const sendToChat = (): void => {
		useUi.getState().insertIntoComposer(`Q: ${asked}\nA: ${answer.trim()}`);
		onClose();
	};

	return (
		<ComposerPopover anchor={anchor} onClose={onClose} label="Side question">
			<div className="flex items-center justify-between border-b border-border px-3 py-1.5">
				<span className="font-condensed text-[11px] font-semibold uppercase tracking-wider text-muted">
					/btw · side question{chat.agent === "agy" ? " · with the chat's gist" : ""}
				</span>
				<span className="font-mono text-[10px] text-muted/70">Esc closes</span>
			</div>
			<form
				className="flex items-start gap-2 px-3 py-2"
				onSubmit={(event) => {
					event.preventDefault();
					void ask(question);
				}}
			>
				<textarea
					autoFocus
					rows={2}
					value={question}
					maxLength={MAX_QUESTION}
					onChange={(event) => setQuestion(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void ask(question);
						}
					}}
					placeholder="Ask about this chat without adding to it…"
					className="min-h-[40px] flex-1 resize-none bg-bg px-2 py-1.5 text-[length:var(--chat-tool)] text-text outline-none ring-1 ring-border focus:glow placeholder:text-muted/70"
				/>
				{status === "running" ? (
					<button type="button" onClick={cancel} className="px-2 py-1.5 font-condensed text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-text">
						Cancel
					</button>
				) : (
					<button
						type="submit"
						disabled={!question.trim()}
						className="cut-corner btn-hot px-3 py-1.5 font-condensed text-[11px] font-semibold uppercase tracking-wider text-white disabled:opacity-30"
					>
						Ask
					</button>
				)}
			</form>
			{status !== "idle" ? (
				<div className="max-h-80 overflow-y-auto border-t border-border px-3 py-2">
					{answer ? <MarkdownText text={answer} /> : null}
					{status === "running" && !answer ? (
						<p className="flex items-center gap-2 font-mono text-[length:var(--chat-meta)] text-muted">
							<Loader2 size={11} className="animate-spin" /> thinking…
						</p>
					) : null}
					{status === "error" ? <p className="font-mono text-[length:var(--chat-meta)] whitespace-pre-wrap text-[#ff4d6a]">{error}</p> : null}
				</div>
			) : null}
			{status === "done" && answer.trim() ? (
				<div className="flex justify-end border-t border-border px-3 py-1.5">
					<button type="button" onClick={sendToChat} className="font-condensed text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-red">
						Send to chat
					</button>
				</div>
			) : null}
		</ComposerPopover>
	);
}
