import type { UiEvent } from "../../../src/main/claude/events.ts";
import { addNotice, EMPTY_CHAT, reduceChat, type Card, type ChatView } from "../../../src/renderer/chat/reduce.ts";

/**
 * A phone chat as the screen draws it. The server's stream
 * (`GET /api/chats/:id/events`) carries the desktop's UiEvents plus its own
 * notices (a saved capture, a vault that did not refresh), and sends no
 * snapshot on connect: the screen opens the stream, then GETs the chat and
 * folds what comes after. Events that arrive before the snapshot are dropped
 * (the snapshot already holds them); the end of a turn and every notice ask
 * for a fresh copy, which settles any drift between the two.
 */

export type Engine = "agy" | "claude";
export type ChatEvent = UiEvent | { readonly kind: "notice"; readonly sessionId: string; readonly text: string };

export type ChatSummary = { id: string; title: string; engine: Engine; createdAt: number; updatedAt: number };
export type ChatSnapshot = ChatSummary & { effort: string; conversationId: string; cards: Card[]; running: boolean };

export function viewFromSnapshot(chat: ChatSnapshot): ChatView {
	const highest = chat.cards.reduce((max, card) => Math.max(max, Number(card.id.slice(1)) || 0), 0);
	const last = chat.cards.at(-1);
	return {
		...EMPTY_CHAT,
		cards: chat.cards,
		nextId: highest + 1,
		sessionId: chat.conversationId,
		running: chat.running,
		pending: chat.running ? 1 : 0,
		// A reply mid-stream when the snapshot was taken keeps growing in its own card.
		streamingId: chat.running && last?.kind === "assistant" ? last.id : null,
	};
}

export function foldEvent(view: ChatView, event: ChatEvent): ChatView {
	return event.kind === "notice" ? addNotice(view, event.text) : reduceChat(view, event);
}

export function parseChatEvent(raw: string): ChatEvent | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return typeof (parsed as { kind?: unknown }).kind === "string" ? (parsed as ChatEvent) : null;
	} catch {
		return null;
	}
}

/** Events after which the screen re-reads the chat from the server. */
export function settles(event: ChatEvent): boolean {
	return event.kind === "turn-end" || event.kind === "turn-cancelled" || event.kind === "run-error" || event.kind === "notice";
}

const RECONNECT_MS = [2000, 5000, 15_000] as const;
const RECONNECT_STEADY_MS = 30_000;

/** How long to wait before reopening a stream the server closed, by attempt (0-based): 2 s, 5 s, 15 s, then every 30 s. */
export function reconnectDelay(attempt: number): number {
	return RECONNECT_MS[attempt] ?? RECONNECT_STEADY_MS;
}

const SAVED = /^Saved to the vault: (.+?)( \(saved, not synced yet\))?$/;

/** "Saved to the vault: thinking/phone-…-router-password.md" reads as "Saved to brain: router password". */
export function noticeLabel(text: string): string {
	const match = SAVED.exec(text);
	if (!match) return text;
	const file = (match[1] ?? "").split("/").at(-1) ?? "";
	const title = file
		.replace(/\.md$/, "")
		.replace(/^phone-\d{4}-\d{2}-\d{2}-\d{4}-/, "")
		.replace(/-/g, " ")
		.trim();
	return `Saved to brain: ${title || file}${match[2] ? " · saved, not synced yet" : ""}`;
}
