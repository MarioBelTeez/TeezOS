import { randomBytes } from "node:crypto";
import type { AgentKind, ChatOptions } from "./registry.ts";

/**
 * Side questions (`/btw`) over IPC, minus Electron: the window asks about a
 * chat and gets an id back; the answer streams as events under that id. The
 * window is untrusted, so everything it sends is checked here.
 */

export type BtwEvent = { readonly btwId: string; readonly kind: "delta" | "done" | "error"; readonly text: string };

export type BtwHooks = {
	readonly onDelta: (text: string) => void;
	readonly onDone: (text: string) => void;
	readonly onError: (message: string) => void;
};

/** What a side question needs to know about the chat it is about. */
export type BtwChat = {
	readonly agent: AgentKind;
	readonly cwd: string;
	readonly model: string;
	/** "" while the chat has no session yet. */
	readonly sessionId: string;
};

type Run = { cancel(): void };
type Listed = { readonly chatId: string; readonly run: Run };

/**
 * What a side question about this chat needs. The model is the one in use
 * now (the registry keeps it current); the session is the live one, or —
 * for a resumed chat that has not reported it yet — the one it resumed.
 */
export function btwChatOf(
	registry: { options(chatId: string): ChatOptions | undefined; sessionId(chatId: string): string },
	chatId: string,
): BtwChat | null {
	const options = registry.options(chatId);
	if (!options) return null;
	return {
		agent: options.agent,
		cwd: options.cwd,
		model: options.model,
		sessionId: registry.sessionId(chatId) || options.resume || "",
	};
}
type Started = Run | { readonly error: string };

export type BtwServiceDeps = {
	readonly chat: (chatId: string) => BtwChat | null;
	readonly startClaude: (request: { readonly cwd: string; readonly model: string; readonly sessionId: string | null; readonly question: string } & BtwHooks) => Started;
	readonly startAgy: (request: { readonly cwd: string; readonly model: string; readonly question: string } & BtwHooks) => Started;
	readonly emit: (event: BtwEvent) => void;
	readonly newId?: () => string;
};

/** A plain question. */
const MAX_QUESTION = 4000;
/** Antigravity's arrives with the hand-over summary (up to 6 000 chars) in front. */
const MAX_AGY_QUESTION = 12000;
/** Each one is a process; a stuck key must not start dozens. */
const MAX_RUNNING = 4;
const CHAT_ID = /^[\w-]{1,64}$/;
export const BTW_ID = /^btw-[a-z0-9]{6,20}$/;

const randomId = (): string => `btw-${randomBytes(6).toString("hex")}`;

export class BtwService {
	readonly #deps: BtwServiceDeps;
	readonly #runs = new Map<string, Listed>();

	constructor(deps: BtwServiceDeps) {
		this.#deps = deps;
	}

	get running(): number {
		return this.#runs.size;
	}

	ask(chatId: unknown, question: unknown): string | { readonly error: string } {
		if (typeof chatId !== "string" || !CHAT_ID.test(chatId)) return { error: "Unknown chat." };
		if (typeof question !== "string") return { error: "The question must be text." };
		const chat = this.#deps.chat(chatId);
		if (!chat) return { error: "This chat is no longer running." };
		// Codex has no side-question runner yet: say so rather than hand the question to another agent.
		if (chat.agent === "codex") return { error: "Side questions (/btw) aren't available in Codex chats yet." };
		const text = question.trim();
		const limit = chat.agent === "agy" ? MAX_AGY_QUESTION : MAX_QUESTION;
		if (text.length === 0) return { error: "Ask something first." };
		if (text.length > limit) return { error: `A side question can be at most ${limit} characters.` };
		if (this.#runs.size >= MAX_RUNNING) return { error: "Too many side questions are running; wait for one to finish." };

		const btwId = (this.#deps.newId ?? randomId)();
		// Events reach the window only while the run is still listed: once
		// it ends or is cancelled, anything late is dropped.
		const live = (): boolean => this.#runs.has(btwId);
		const hooks: BtwHooks = {
			onDelta: (delta) => {
				if (live()) this.#deps.emit({ btwId, kind: "delta", text: delta });
			},
			onDone: (answer) => {
				if (!live()) return;
				this.#runs.delete(btwId);
				this.#deps.emit({ btwId, kind: "done", text: answer });
			},
			onError: (message) => {
				if (!live()) return;
				this.#runs.delete(btwId);
				this.#deps.emit({ btwId, kind: "error", text: message });
			},
		};
		// Listed before starting: a runner may report its first event at once.
		const pending: Listed = { chatId, run: { cancel: () => undefined } };
		this.#runs.set(btwId, pending);
		let started: Started;
		try {
			started =
				chat.agent === "claude"
					? this.#deps.startClaude({ cwd: chat.cwd, model: chat.model, sessionId: chat.sessionId || null, question: text, ...hooks })
					: this.#deps.startAgy({ cwd: chat.cwd, model: chat.model, question: text, ...hooks });
		} catch (error) {
			started = { error: error instanceof Error ? error.message : String(error) };
		}
		if ("error" in started) {
			this.#runs.delete(btwId);
			return { error: started.error };
		}
		// Unless it already finished while starting.
		if (this.#runs.get(btwId) === pending) this.#runs.set(btwId, { chatId, run: started });
		return btwId;
	}

	cancel(btwId: unknown): void {
		if (typeof btwId !== "string" || !BTW_ID.test(btwId)) return;
		const listed = this.#runs.get(btwId);
		if (!listed) return;
		this.#runs.delete(btwId);
		listed.run.cancel();
	}

	/** A closed chat takes its side questions with it. */
	cancelChat(chatId: string): void {
		for (const [btwId, listed] of [...this.#runs]) {
			if (listed.chatId !== chatId) continue;
			this.#runs.delete(btwId);
			listed.run.cancel();
		}
	}

	disposeAll(): void {
		const runs = [...this.#runs.values()];
		this.#runs.clear();
		for (const listed of runs) listed.run.cancel();
	}
}
