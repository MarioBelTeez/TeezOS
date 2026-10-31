import type { ContextUse, UiEvent } from "../../main/claude/events.ts";
import type { ApprovalRequest } from "../../main/claude/service.ts";
import type { PauseChange } from "../../main/agents/auto-continue.ts";

/**
 * A chat as the window draws it: a list of cards built from the event stream.
 *
 * Pure on purpose — the same function folds live events and a transcript
 * replayed from disk, and it is tested without a window. Streaming text is
 * appended to the assistant card in flight, tool results are matched back to
 * the card that started them, and approvals become cards of their own so the
 * buttons sit where the eye already is.
 */

/** A call a subagent made, drawn inside the Agent card that started it. */
export type ToolStep = {
	readonly toolUseId: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly status: "running" | "done" | "failed";
	readonly result: string;
};

export type Card =
	| { readonly id: string; readonly kind: "user"; readonly text: string; readonly images?: readonly string[] }
	| { readonly id: string; readonly kind: "assistant"; readonly text: string }
	| {
			readonly id: string;
			readonly kind: "tool";
			readonly toolUseId: string;
			readonly name: string;
			readonly input: Readonly<Record<string, unknown>>;
			readonly status: "running" | "done" | "failed";
			readonly result: string;
			/** Agent/Task cards only: the subagent's own calls, in order. */
			readonly steps?: readonly ToolStep[];
			/** Agent/Task cards only: what the subagent said along the way. */
			readonly summary?: string;
	  }
	| {
			readonly id: string;
			readonly kind: "approval";
			readonly requestId: string;
			readonly toolName: string;
			readonly input: Readonly<Record<string, unknown>>;
			readonly decision: "pending" | "allow" | "deny" | "expired";
	  }
	| { readonly id: string; readonly kind: "error"; readonly reason: string; readonly text: string }
	| { readonly id: string; readonly kind: "cancelled"; readonly durationMs: number }
	| {
			readonly id: string;
			readonly kind: "turn";
			readonly durationMs: number;
			readonly costUsd: number;
	  }
	| { readonly id: string; readonly kind: "notice"; readonly text: string };

export type ChatView = {
	readonly cards: readonly Card[];
	readonly running: boolean;
	readonly sessionId: string;
	readonly sessionModel: string;
	/** The assistant card receiving deltas, if a reply is streaming. */
	readonly streamingId: string | null;
	readonly nextId: number;
	readonly totalCostUsd: number;
	/**
	 * The session's running cost as last reported. Claude reports a cumulative
	 * total on every result (per its SDK docs), so a turn's own cost is the
	 * difference from the previous one — summing the totals over-counted.
	 */
	readonly reportedCostUsd: number;
	/** Messages sent and not yet answered: a message sent mid-turn queues. */
	readonly pending: number;
	readonly slashCommands: readonly string[];
	/** Tokens in context at the last turn's end, out of the model's window; null until one reports it. */
	readonly context: ContextUse | null;
	/** Turns finished in this chat. */
	readonly turns: number;
	/** Set while the chat waits for a plan limit to reset, to carry on by itself. */
	readonly pause: PauseView | null;
};

/** When a paused chat resumes (epoch ms); `estimated` when the reset time was unknown and it retries on a schedule. */
export type PauseView = { readonly resumesAt: number; readonly estimated: boolean };

export const EMPTY_CHAT: ChatView = {
	cards: [],
	running: false,
	sessionId: "",
	sessionModel: "",
	streamingId: null,
	nextId: 1,
	totalCostUsd: 0,
	reportedCostUsd: 0,
	pending: 0,
	slashCommands: [],
	context: null,
	turns: 0,
	pause: null,
};

/** 150000 → "150k": a divider wants the gist, not the digits. */
function tokens(count: number): string {
	return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

function withCard(chat: ChatView, make: (id: string) => Card): ChatView {
	const id = `c${chat.nextId}`;
	return { ...chat, cards: [...chat.cards, make(id)], nextId: chat.nextId + 1 };
}

/**
 * The top-level card a subagent's event belongs to: the Agent card with that
 * id, or — for a subagent started by a subagent — the card already holding
 * that call as a step, so nesting stays one level deep.
 */
function ownerOf(cards: readonly Card[], parentToolUseId: string): number {
	return cards.findLastIndex(
		(card) =>
			card.kind === "tool" &&
			(card.toolUseId === parentToolUseId || (card.steps ?? []).some((step) => step.toolUseId === parentToolUseId)),
	);
}

function updateCard(chat: ChatView, index: number, change: (card: Card) => Card): ChatView {
	return { ...chat, cards: chat.cards.map((card, i) => (i === index ? change(card) : card)) };
}

/** Anything still waiting for a click when a turn ends can no longer be answered. */
function expireApprovals(cards: readonly Card[]): readonly Card[] {
	return cards.map((card) =>
		card.kind === "approval" && card.decision === "pending"
			? { ...card, decision: "expired" as const }
			: card,
	);
}

/** `images` are small data URLs (thumbnails), kept only to show what was sent. */
export function addUserMessage(chat: ChatView, text: string, images: readonly string[] = []): ChatView {
	return {
		...withCard(chat, (id) => (images.length > 0 ? { id, kind: "user", text, images } : { id, kind: "user", text })),
		running: true,
		pending: chat.pending + 1,
		streamingId: null,
	};
}

export function addNotice(chat: ChatView, text: string): ChatView {
	return withCard(chat, (id) => ({ id, kind: "notice", text }));
}

/** What main says about a chat's wait for a limit reset. */
export function applyPause(chat: ChatView, change: PauseChange): ChatView {
	switch (change.kind) {
		case "waiting":
			return { ...chat, pause: { resumesAt: change.resumesAt, estimated: change.estimated } };
		case "cleared":
			return { ...chat, pause: null };
		case "resumed":
			return {
				...withCard(chat, (id) => ({ id, kind: "notice", text: "Continued automatically after the limit reset" })),
				pause: null,
				running: true,
				pending: chat.pending + 1,
				streamingId: null,
			};
	}
}

export function addApproval(chat: ChatView, request: ApprovalRequest): ChatView {
	return withCard(chat, (id) => ({
		id,
		kind: "approval",
		requestId: request.id,
		toolName: request.toolName,
		input: request.input,
		decision: "pending",
	}));
}

export function decideApproval(
	chat: ChatView,
	requestId: string,
	decision: "allow" | "deny",
): ChatView {
	return {
		...chat,
		cards: chat.cards.map((card) =>
			card.kind === "approval" && card.requestId === requestId ? { ...card, decision } : card,
		),
	};
}

export function reduceChat(chat: ChatView, event: UiEvent): ChatView {
	switch (event.kind) {
		case "session-ready":
			return {
				...chat,
				sessionId: event.sessionId,
				sessionModel: event.model,
				slashCommands: event.slashCommands.length > 0 ? event.slashCommands : chat.slashCommands,
			};

		case "text-delta": {
			const streaming = chat.streamingId;
			if (streaming) {
				return {
					...chat,
					cards: chat.cards.map((card) =>
						card.id === streaming && card.kind === "assistant"
							? { ...card, text: card.text + event.text }
							: card,
					),
				};
			}
			const id = `c${chat.nextId}`;
			return {
				...chat,
				cards: [...chat.cards, { id, kind: "assistant", text: event.text }],
				nextId: chat.nextId + 1,
				streamingId: id,
			};
		}

		case "text":
			return withCard({ ...chat, streamingId: null }, (id) => ({
				id,
				kind: "assistant",
				text: event.text,
			}));

		case "tool-start": {
			const step: ToolStep = { toolUseId: event.toolUseId, name: event.name, input: event.input, status: "running", result: "" };
			// A subagent's call is a step of its Agent card. It is not the main
			// agent's, so the main reply in flight keeps streaming. With no card
			// to hold it (a resumed transcript cut short), it is drawn on its own,
			// still without splitting the main reply.
			if (event.parentToolUseId) {
				const owner = ownerOf(chat.cards, event.parentToolUseId);
				if (owner < 0) return withCard(chat, (id) => ({ id, kind: "tool", ...step }));
				return updateCard(chat, owner, (card) => (card.kind === "tool" ? { ...card, steps: [...(card.steps ?? []), step] } : card));
			}
			// A tool call ends the text in flight; text after it is a new card.
			return withCard({ ...chat, streamingId: null }, (id) => ({ id, kind: "tool", ...step }));
		}

		case "tool-end": {
			const status = event.isError ? ("failed" as const) : ("done" as const);
			return {
				...chat,
				cards: chat.cards.map((card) => {
					if (card.kind !== "tool") return card;
					if (card.toolUseId === event.toolUseId) return { ...card, status, result: event.content };
					if (!card.steps?.some((s) => s.toolUseId === event.toolUseId)) return card;
					return {
						...card,
						steps: card.steps.map((s) => (s.toolUseId === event.toolUseId ? { ...s, status, result: event.content } : s)),
					};
				}),
			};
		}

		case "subagent-text": {
			// Not the answer to the user: it reads as the Agent card's running
			// commentary instead.
			const owner = ownerOf(chat.cards, event.parentToolUseId);
			if (owner < 0) return chat;
			return updateCard(chat, owner, (card) =>
				card.kind === "tool" ? { ...card, summary: card.summary ? `${card.summary}\n\n${event.text}` : event.text } : card,
			);
		}

		case "turn-end": {
			// A total lower than the last one means the session started counting
			// again (resumed, or /clear): this turn's cost is then the whole figure.
			const turnCost = event.costUsd >= chat.reportedCostUsd ? event.costUsd - chat.reportedCostUsd : event.costUsd;
			const pending = Math.max(0, chat.pending - 1);
			return withCard(
				{
					...chat,
					cards: pending > 0 ? chat.cards : expireApprovals(chat.cards),
					running: pending > 0,
					pending,
					streamingId: null,
					totalCostUsd: chat.totalCostUsd + turnCost,
					reportedCostUsd: event.costUsd,
					// A turn that reported no usage leaves the last known figure.
					context: event.context ?? chat.context,
					turns: chat.turns + 1,
				},
				(id) => ({ id, kind: "turn", durationMs: event.durationMs, costUsd: turnCost }),
			);
		}

		case "turn-cancelled":
			// Stop interrupts the turn and drops anything queued behind it.
			return withCard(
				{ ...chat, cards: expireApprovals(chat.cards), running: false, pending: 0, streamingId: null },
				(id) => ({ id, kind: "cancelled", durationMs: event.durationMs }),
			);

		case "run-error": {
			const pending = event.reason === "chat-closed" ? 0 : Math.max(0, chat.pending - 1);
			// A message refused at the bridge never reached the agent: whatever turn
			// is running (and any approval it waits on) is untouched.
			if (event.reason === "bad-image") {
				return withCard({ ...chat, running: pending > 0, pending }, (id) => ({ id, kind: "error", reason: event.reason, text: event.message }));
			}
			return withCard(
				{ ...chat, cards: expireApprovals(chat.cards), running: pending > 0, pending, streamingId: null },
				(id) => ({ id, kind: "error", reason: event.reason, text: event.message }),
			);
		}

		case "compacted": {
			const after = event.postTokens;
			const sizes = after === null ? `${tokens(event.preTokens)} tokens before` : `${tokens(event.preTokens)} → ${tokens(after)} tokens`;
			// Drawn as a divider; a reply in flight carries on streaming above it.
			return withCard(
				{ ...chat, context: chat.context && after !== null ? { ...chat.context, used: after } : chat.context },
				(id) => ({ id, kind: "notice", text: `Context compacted · ${sizes}` }),
			);
		}

		default:
			return chat;
	}
}

/** A past session's items folded into a finished chat, ready to resume. */
export function foldHistory(
	items: readonly ({ readonly kind: "user"; readonly text: string } | UiEvent)[],
): ChatView {
	let chat = EMPTY_CHAT;
	for (const item of items) {
		chat = item.kind === "user" ? { ...addUserMessage(chat, item.text), running: false } : reduceChat(chat, item);
	}
	return { ...chat, running: false, pending: 0, streamingId: null };
}
