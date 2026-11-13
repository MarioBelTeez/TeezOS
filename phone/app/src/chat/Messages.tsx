import { useEffect, useRef, type ReactNode } from "react";
import type { Card } from "../../../../src/renderer/chat/reduce.ts";
import { noticeLabel } from "../chat-stream.ts";
import { Markdown } from "../components/Markdown.tsx";
import { duration } from "../format.ts";
import { nearBottom } from "../scroll.ts";

/**
 * A chat's cards for a phone: the user's messages on the right, replies as
 * markdown, tool calls as one quiet line each, notices as dividers. A long
 * press or "…" on a message offers its actions (Save to brain).
 */

const LONG_PRESS_MS = 500;

function useLongPress(onLongPress: () => void) {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancel = (): void => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	};
	return {
		onTouchStart: () => {
			cancel();
			timer.current = setTimeout(onLongPress, LONG_PRESS_MS);
		},
		onTouchMove: cancel,
		onTouchEnd: cancel,
		onTouchCancel: cancel,
		onContextMenu: (event: { preventDefault(): void }) => {
			event.preventDefault();
			onLongPress();
		},
	};
}

function Message({ card, streaming, onActions }: { card: Card & { kind: "user" | "assistant" }; streaming: boolean; onActions?: (text: string) => void }): ReactNode {
	const press = useLongPress(() => onActions?.(card.text));
	const mine = card.kind === "user";
	return (
		<div className={`group flex items-start gap-1 ${mine ? "flex-row-reverse" : ""}`}>
			<div
				{...(onActions ? press : {})}
				className={`min-w-0 select-text ${mine ? "max-w-[85%] rounded-2xl bg-surface-2 px-3.5 py-2.5 font-sans text-[16px] leading-relaxed whitespace-pre-wrap shadow-[inset_0_0_0_1px_var(--color-border)]" : "flex-1 px-0.5 py-1.5"} ${streaming ? "stream-caret" : ""}`}
			>
				{mine ? card.text : <Markdown text={card.text} />}
			</div>
			{onActions && !streaming ? (
				<button type="button" aria-label="Message actions" onClick={() => onActions(card.text)} className="h-9 min-w-9 shrink-0 text-[18px] text-muted active:text-red-hot">
					…
				</button>
			) : null}
		</div>
	);
}

function Line({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" | "notice" }): ReactNode {
	const colour = tone === "error" ? "border-red-hot text-[#ff8da0]" : tone === "notice" ? "border-violet text-text" : "border-border text-muted";
	return <p className={`border-l-2 px-3 py-1 font-mono text-[13px] ${colour}`}>{children}</p>;
}

function toolSummary(input: Readonly<Record<string, unknown>>): string {
	const first = ["file_path", "path", "pattern", "query", "command", "url"].map((key) => input[key]).find((value) => typeof value === "string");
	return typeof first === "string" ? first : "";
}

function CardView({ card, streamingId, onActions }: { card: Card; streamingId: string | null; onActions?: (text: string) => void }): ReactNode {
	switch (card.kind) {
		case "user":
		case "assistant":
			return <Message card={card} streaming={card.id === streamingId} {...(onActions ? { onActions } : {})} />;
		case "tool": {
			const mark = card.status === "running" ? "…" : card.status === "failed" ? "✕" : "✓";
			return (
				<Line>
					{mark} {card.name} <span className="opacity-70">{toolSummary(card.input)}</span>
				</Line>
			);
		}
		case "notice":
			return <Line tone="notice">{noticeLabel(card.text)}</Line>;
		case "error":
			return <Line tone="error">{card.text}</Line>;
		case "cancelled":
			return <Line>Stopped after {duration(card.durationMs / 1000)}</Line>;
		case "turn":
			return <p className="text-right font-mono text-[11px] text-muted/70">{duration(card.durationMs / 1000)}</p>;
		case "approval":
			return <Line>{card.toolName} needed an approval the phone cannot give.</Line>;
	}
}

export function Messages({ cards, streamingId, running, onActions, empty }: { cards: readonly Card[]; streamingId: string | null; running: boolean; onActions?: (text: string) => void; empty?: ReactNode }): ReactNode {
	const end = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const last = cards.at(-1);
	const lastSize = last && "text" in last ? last.text.length : 0;

	// Follow new content down only while the reader is at the end; reading further up stays put.
	useEffect(() => {
		const box = end.current?.closest(".scroll-y");
		if (!box) return;
		const onScroll = (): void => {
			stick.current = nearBottom(box);
		};
		box.addEventListener("scroll", onScroll, { passive: true });
		return () => box.removeEventListener("scroll", onScroll);
	}, []);

	useEffect(() => {
		// the user's own message always brings the end into view.
		if (stick.current || last?.kind === "user") end.current?.scrollIntoView({ block: "end" });
	}, [cards.length, lastSize]);

	// The end sentinel is always rendered, so the scroll listener above can find its container on the first render, even with no messages yet.
	return (
		<>
			{cards.length === 0 && empty ? (
				empty
			) : (
				<div className="flex flex-col gap-3 py-3">
					{cards.map((card) => (
						<CardView key={card.id} card={card} streamingId={streamingId} {...(onActions ? { onActions } : {})} />
					))}
					{running && streamingId === null ? (
						<p className="flex items-center gap-2 font-mono text-[13px] text-muted">
							<span className="pulse-dot inline-block h-2 w-2 rounded-full bg-red-hot" /> Working…
						</p>
					) : null}
				</div>
			)}
			<div ref={end} />
		</>
	);
}
