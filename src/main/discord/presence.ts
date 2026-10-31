import type { UiEvent } from "../claude/events.ts";
import type { AgentKind } from "../agents/registry.ts";
import { visible } from "../agents/attention.ts";

/**
 * What TeezAI tells Discord. Pure: the tracker follows each chat through a
 * turn, and buildActivity turns the busiest chat into Discord's two lines of
 * text. The service decides when to send it.
 */

export type PresenceMode = "on" | "private" | "off";
export const PRESENCE_MODES: readonly PresenceMode[] = ["on", "private", "off"];

type ChatState = {
	readonly agent: AgentKind;
	readonly workspace: string;
	readonly waiting: boolean;
	/** Messages sent and not yet answered: one sent mid-turn queues a second turn. */
	readonly turns: number;
};

export type PresenceSnapshot =
	| { readonly state: "idle"; readonly running: 0 }
	| {
			readonly state: "working" | "waiting";
			readonly agent: AgentKind;
			readonly workspace: string;
			/** Chats with a turn running, waiting ones included. */
			readonly running: number;
	  };

export class PresenceTracker {
	/** Only chats with a turn running; an idle chat is simply absent. */
	readonly #running = new Map<string, ChatState>();

	/** A message went out: the chat is working. Each call returns whether anything changed. */
	sent(chatId: string, agent: AgentKind, workspace: string): boolean {
		const before = this.#running.get(chatId);
		if (before) {
			this.#running.set(chatId, { ...before, turns: before.turns + 1 });
			return false;
		}
		this.#running.set(chatId, { agent, workspace, waiting: false, turns: 1 });
		return true;
	}

	waiting(chatId: string): boolean {
		return this.#setWaiting(chatId, true);
	}

	approved(chatId: string): boolean {
		return this.#setWaiting(chatId, false);
	}

	event(chatId: string, event: UiEvent): boolean {
		const chat = this.#running.get(chatId);
		if (!chat) return false;
		// A stop or a failure ends everything queued; a finished turn only its own.
		if (event.kind === "turn-cancelled" || event.kind === "run-error" || (event.kind === "turn-end" && chat.turns <= 1)) {
			return this.#running.delete(chatId);
		}
		if (event.kind === "turn-end") {
			this.#running.set(chatId, { ...chat, turns: chat.turns - 1, waiting: false });
			return chat.waiting;
		}
		return false;
	}

	closed(chatId: string): boolean {
		return this.#running.delete(chatId);
	}

	/** Forget chats that were closed without a word, e.g. with their workspace. */
	prune(isOpen: (chatId: string) => boolean): boolean {
		let changed = false;
		for (const chatId of [...this.#running.keys()]) {
			if (!isOpen(chatId)) changed = this.#running.delete(chatId) || changed;
		}
		return changed;
	}

	snapshot(): PresenceSnapshot {
		const chats = [...this.#running.values()];
		// Newest first, so the chat that just started is the one named.
		const pick = chats.findLast((c) => c.waiting) ?? chats[chats.length - 1];
		if (!pick) return { state: "idle", running: 0 };
		return { state: pick.waiting ? "waiting" : "working", agent: pick.agent, workspace: pick.workspace, running: chats.length };
	}

	#setWaiting(chatId: string, waiting: boolean): boolean {
		const chat = this.#running.get(chatId);
		if (!chat || chat.waiting === waiting) return false;
		this.#running.set(chatId, { ...chat, waiting });
		return true;
	}
}

/** The shape Discord's SET_ACTIVITY takes; only the fields TeezAI uses. */
export type Activity = {
	readonly details: string;
	readonly state?: string;
	readonly timestamps: { readonly start: number };
	readonly assets: { readonly large_image: string; readonly large_text: string };
};

export type ActivityContext = {
	readonly mode: PresenceMode;
	readonly activeWorkspace: string | null;
	readonly version: string;
	readonly startedAt: number;
};

const AGENT_NAME: Record<AgentKind, string> = { claude: "Claude", agy: "Antigravity" };
/** Discord refuses a field shorter than 2 or longer than 128 characters. */
const MAX_FIELD = 128;
/** The key of the logo uploaded under Rich Presence → Art Assets. */
export const LARGE_IMAGE = "teezai";

function clean(text: string): string {
	const shown = visible(text).trim();
	return shown.length > MAX_FIELD ? `${shown.slice(0, MAX_FIELD - 1)}…` : shown;
}

export function buildActivity(snapshot: PresenceSnapshot, context: ActivityContext): Activity | null {
	if (context.mode === "off") return null;

	let details = "Idle";
	let workspace = context.activeWorkspace;
	if (snapshot.state !== "idle") {
		const name = AGENT_NAME[snapshot.agent];
		details = snapshot.state === "waiting" ? `${name} is waiting for approval` : `${name} is working`;
		if (snapshot.running > 1) details += ` · ${snapshot.running} chats`;
		workspace = snapshot.workspace;
	}

	const where = context.mode === "on" && workspace ? clean(workspace) : "";
	return {
		details,
		...(where ? { state: clean(`in ${where}`) } : {}),
		timestamps: { start: context.startedAt },
		assets: { large_image: LARGE_IMAGE, large_text: `TeezOS ${context.version}` },
	};
}
