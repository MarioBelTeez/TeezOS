import { randomUUID } from "node:crypto";
import { agyRules } from "../../../../runner/src/agy.ts";
import type { UiEvent } from "../../../../src/main/claude/events.ts";
import { addNotice, addUserMessage, EMPTY_CHAT, reduceChat, type ChatView } from "../../../../src/renderer/chat/reduce.ts";
import type { Capture } from "./capture-block.ts";
import type { ChatStore, Engine, StoredChat } from "./chat-store.ts";
import { runAgyTurn, runClaudeTurn, type Turn, type TurnRequest } from "./engines.ts";
import type { SaveCapture, SavedCapture } from "../routes/captures.ts";
import { JobUser, KILL_GRACE_MS, type Spawn } from "./job-user.ts";
import { ReplyShaper, within } from "./reply-shaper.ts";

/**
 * Phone chats: an agent that reads the TeezMind vault and changes nothing.
 * Each turn writes agy's read-only rules, asks the service to freshen its own
 * clone (GitSync; the job user never pulls), then runs the engine as the job
 * user (`phoneagent`). Anything worth keeping comes back as a capture
 * block, which the service — never the model — saves as a new capture note.
 *
 * Turns run one at a time across all chats: agy's rules live in one settings
 * file per account, and two agy runs refreshing the login at once was seen to
 * fail one of them (runner/src/agy.ts). A turn that runs past TURN_TIMEOUT_MS
 * is stopped, so one hung process cannot block every chat.
 */

export const PREAMBLE =
	"You are TeezOS on the user's phone. Answer from the TeezMind vault in this folder: search and read notes, cite them as [[wikilinks]]. You cannot change files. When the user asks you to remember or log something, or says something worth keeping, end your reply with <teez-capture links=\"Note A|Note B\">the thing to remember, in one or a few plain sentences</teez-capture>. Keep answers short; this is a phone.";

/** A UiEvent, or a notice the service adds (a saved capture, a vault that did not refresh). */
export type ChatEvent = UiEvent | { readonly kind: "notice"; readonly sessionId: string; readonly text: string };
export type ReplyDone = (chatId: string, title: string, firstLine: string) => void;

export const TURN_TIMEOUT_MS = 15 * 60_000;
const FRESHEN_TIMEOUT_MS = 30_000;
/** After the SIGKILL, how long the killed turn may take to report its end. */
const STOP_SLACK_MS = 5_000;
const TIMEOUT_MESSAGE = "The turn took too long and was stopped.";
const PULL_FAILED = "The vault could not be refreshed (git pull failed); answering from the copy already on the server.";

export type ChatServiceDeps = {
	readonly store: ChatStore;
	readonly saveCapture: SaveCapture;
	readonly spawn: Spawn;
	readonly jobUser: string | undefined;
	readonly agentVaultDir: string;
	/** agy for the job user; null while it is unknown or not installed. */
	readonly agyPath: () => string | null;
	readonly claudePath: string;
	/** The server's Claude OAuth token, or null without one. */
	readonly claudeToken: () => string | null;
	/** Pulls the service's vault clone (GitSync.pull); true when it worked. Bounded at 30 s per turn. */
	readonly freshen?: () => Promise<boolean>;
	readonly turnTimeoutMs?: number;
	readonly now?: () => number;
};

type Live = {
	chat: StoredChat;
	view: ChatView;
	queue: string[];
	busy: boolean;
	cancel: boolean;
	turn: Turn | null;
	listeners: Set<(event: ChatEvent) => void>;
};

const NEW_TITLE = "New chat";
const TITLE_CHARS = 60;
const FIRST_LINE_CHARS = 140;

/** The notice a saved capture leaves in the chat. */
export const savedNotice = (saved: SavedCapture): string => `Saved to the vault: ${saved.path}${saved.synced ? "" : " (saved, not synced yet)"}`;

const firstLine = (text: string, max: number): string => (text.trim().split("\n")[0] ?? "").replace(/\s+/g, " ").slice(0, max);

/** Card ids are `c<n>`; a reloaded chat carries on numbering after the highest. */
function viewOf(chat: StoredChat): ChatView {
	const highest = chat.cards.reduce((max, card) => Math.max(max, Number(card.id.slice(1)) || 0), 0);
	return { ...EMPTY_CHAT, cards: chat.cards, nextId: highest + 1, sessionId: chat.conversationId };
}

export class ChatService {
	readonly deps: ChatServiceDeps;
	readonly #jobUser: JobUser;
	readonly #live = new Map<string, Live>();
	readonly #replyListeners = new Set<ReplyDone>();
	#lock: Promise<void> = Promise.resolve();

	constructor(deps: ChatServiceDeps) {
		this.deps = deps;
		this.#jobUser = new JobUser(deps.spawn, deps.jobUser);
	}

	#now(): number {
		return (this.deps.now ?? Date.now)();
	}

	create(options: { engine: Engine; effort: string }): StoredChat {
		const now = this.#now();
		const chat: StoredChat = { id: randomUUID(), title: NEW_TITLE, engine: options.engine, effort: options.effort, conversationId: "", cards: [], createdAt: now, updatedAt: now };
		this.deps.store.save(chat);
		return chat;
	}

	list() {
		return this.deps.store.list();
	}

	get(chatId: string): (StoredChat & { running: boolean }) | null {
		const live = this.#live.get(chatId);
		if (live) return { ...live.chat, cards: [...live.view.cards], running: live.busy };
		const chat = this.deps.store.get(chatId);
		return chat ? { ...chat, running: false } : null;
	}

	#load(chatId: string): Live | null {
		const existing = this.#live.get(chatId);
		if (existing) return existing;
		const chat = this.deps.store.get(chatId);
		if (!chat) return null;
		const live: Live = { chat, view: viewOf(chat), queue: [], busy: false, cancel: false, turn: null, listeners: new Set() };
		this.#live.set(chatId, live);
		return live;
	}

	#persist(live: Live): void {
		live.chat = { ...live.chat, cards: [...live.view.cards], updatedAt: this.#now() };
		this.deps.store.save(live.chat);
	}

	#broadcast(live: Live, event: ChatEvent): void {
		for (const listener of live.listeners) {
			try {
				listener(event);
			} catch (error) {
				console.error("phone: chat listener failed", error);
			}
		}
	}

	#apply(live: Live, event: UiEvent): void {
		live.view = reduceChat(live.view, event);
		this.#broadcast(live, event);
	}

	/** Adds a notice card to the chat and tells its listeners. */
	notice(chatId: string, text: string): void {
		const live = this.#load(chatId);
		if (!live) return;
		live.view = addNotice(live.view, text);
		this.#broadcast(live, { kind: "notice", sessionId: live.chat.conversationId, text });
		if (!live.busy) this.#persist(live);
	}

	/** Queues a message; turns run in order. Throws for an unknown chat. */
	send(chatId: string, text: string): void {
		const live = this.#load(chatId);
		if (!live) throw new Error(`no chat ${chatId}`);
		if (live.chat.title === NEW_TITLE) live.chat = { ...live.chat, title: firstLine(text, TITLE_CHARS) || NEW_TITLE };
		live.view = addUserMessage(live.view, text);
		live.queue.push(text);
		this.#persist(live);
		if (!live.busy) void this.#drain(live);
	}

	/** Ends the running turn and drops the queued ones. */
	async stop(chatId: string): Promise<void> {
		const live = this.#live.get(chatId);
		if (!live?.busy) return;
		live.queue = [];
		live.cancel = true;
		live.turn?.stop();
	}

	subscribe(chatId: string, listener: (event: ChatEvent) => void): () => void {
		const live = this.#load(chatId);
		if (!live) return () => undefined;
		live.listeners.add(listener);
		return () => live.listeners.delete(listener);
	}

	/** Whether the chat is open somewhere (an events stream is listening): its reply needs no push then. */
	watching(chatId: string): boolean {
		return (this.#live.get(chatId)?.listeners.size ?? 0) > 0;
	}

	onReplyDone(listener: ReplyDone): () => void {
		this.#replyListeners.add(listener);
		return () => this.#replyListeners.delete(listener);
	}

	async #drain(live: Live): Promise<void> {
		live.busy = true;
		try {
			for (let text = live.queue.shift(); text !== undefined; text = live.queue.shift()) {
				live.cancel = false;
				const message = text;
				const run = this.#lock.then(() => this.#turn(live, message));
				this.#lock = run.catch(() => undefined);
				try {
					await run;
				} catch (error) {
					console.error("phone: chat turn failed", error);
					this.#apply(live, { kind: "run-error", sessionId: live.chat.conversationId, reason: "phone-error", message: "The turn failed on the server." });
				}
				this.#persist(live);
			}
		} finally {
			live.busy = false;
			// The final save records that nothing is running any more.
			this.#persist(live);
		}
	}

	#cancelled(live: Live, started: number): boolean {
		if (!live.cancel) return false;
		this.#apply(live, { kind: "turn-cancelled", sessionId: live.chat.conversationId, durationMs: this.#now() - started });
		return true;
	}

	#fail(live: Live, reason: string, message: string): void {
		this.#apply(live, { kind: "run-error", sessionId: live.chat.conversationId, reason, message });
	}

	/** Checks the engine can run and prepares it; a turn starter, or null after reporting why not. */
	async #prepare(live: Live): Promise<((request: TurnRequest) => Turn) | null> {
		if (live.chat.engine === "claude") {
			const token = this.deps.claudeToken();
			if (!token) {
				this.#fail(live, "claude-no-token", "Claude needs a token on the server (claude setup-token).");
				return null;
			}
			return (request) => runClaudeTurn({ ...request, claudePath: this.deps.claudePath, token });
		}
		const agyPath = this.deps.agyPath();
		if (!agyPath) {
			this.#fail(live, "agy-not-found", "Antigravity is not installed (or not found yet) for the agent account on the server.");
			return null;
		}
		const rules = await this.#jobUser.writeAgyRules(agyRules("read-only"));
		if (!rules.ok) {
			this.#fail(live, "agy-rules", `Could not set Antigravity's read-only rules: ${rules.output}`);
			return null;
		}
		return (request) => runAgyTurn({ ...request, agyPath });
	}

	async #turn(live: Live, text: string): Promise<void> {
		const started = this.#now();
		if (this.#cancelled(live, started)) return;
		const start = await this.#prepare(live);
		if (!start) return;
		if (this.deps.freshen && !(await within(this.deps.freshen(), FRESHEN_TIMEOUT_MS, false))) this.notice(live.chat.id, PULL_FAILED);
		if (this.#cancelled(live, started)) return;

		// A turn stopped for running too long has already been reported: the shaper is closed then.
		const shaper = new ReplyShaper((event) => this.#apply(live, event));
		const onEvent = shaper.onEvent;

		const prompt = live.chat.conversationId ? text : `${PREAMBLE}\n\n${text}`;
		const turn = start({ jobUser: this.#jobUser, cwd: this.deps.agentVaultDir, effort: live.chat.effort, conversationId: live.chat.conversationId, prompt, onEvent });
		live.turn = turn;
		if (live.cancel) turn.stop();
		const TIMED_OUT = Symbol("timed out");
		const conversationId = await within<string | typeof TIMED_OUT>(turn.done, this.deps.turnTimeoutMs ?? TURN_TIMEOUT_MS, TIMED_OUT);
		live.turn = null;
		if (conversationId === TIMED_OUT) {
			shaper.close();
			turn.stop();
			this.#apply(live, { kind: "run-error", sessionId: live.chat.conversationId, reason: "phone-timeout", message: TIMEOUT_MESSAGE });
			// Holds the lock until the process has really ended (killed outright after KILL_GRACE_MS), so it never overlaps the next turn.
			await within(turn.done, KILL_GRACE_MS + STOP_SLACK_MS, "");
			return;
		}
		if (conversationId) live.chat = { ...live.chat, conversationId };

		const finished = shaper.reply;
		if (!finished) return;
		await this.#saveCaptures(live, finished.captures);
		this.#persist(live);
		const line = firstLine(finished.text, FIRST_LINE_CHARS);
		for (const listener of this.#replyListeners) {
			try {
				listener(live.chat.id, live.chat.title, line);
			} catch (error) {
				console.error("phone: reply listener failed", error);
			}
		}
	}

	async #saveCaptures(live: Live, captures: readonly Capture[]): Promise<void> {
		for (const capture of captures) {
			try {
				// A capture block comes from the model, not from the user: marked as such.
				const saved = await this.deps.saveCapture(capture.text, capture.links, { provenance: "phone-chat" });
				this.notice(live.chat.id, savedNotice(saved));
			} catch (error) {
				this.notice(live.chat.id, `Could not save a capture: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}
