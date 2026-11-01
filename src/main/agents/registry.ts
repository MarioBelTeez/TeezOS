import { randomUUID } from "node:crypto";
import type { UiEvent } from "../claude/events.ts";
import type { ApprovalDecision, ApprovalRequest } from "../claude/service.ts";
import type { ChatImage } from "../../shared/images.ts";
import type { ClaudeUsage } from "../../shared/usage.ts";

/**
 * Every open chat, whichever agent runs it.
 *
 * The renderer only ever names a chat by the id handed out here; the agent's
 * own session id arrives later inside the events and is not something the
 * window could route by (Antigravity does not even have one until its first
 * turn ends).
 */

export type AgentKind = "claude" | "agy" | "codex";

/** A slash command as the composer's menu lists it. */
export type SlashCommandInfo = {
	readonly name: string;
	readonly description: string;
	readonly argumentHint: string;
};

/** What a chat needs from whichever agent runs it. */
export interface AgentSession {
	/** The agent's own id for the conversation ("" until it has reported one). */
	readonly sessionId: string;
	send(text: string, images?: readonly ChatImage[]): void;
	stop(): Promise<void>;
	respondToApproval(id: string, decision: ApprovalDecision): void;
	setModel(model: string): Promise<void>;
	setPermissionMode(mode: string): Promise<void>;
	/** How hard the agent thinks from the next request on (see shared/effort.ts). */
	setEffort(effort: string): Promise<void>;
	commands(): Promise<SlashCommandInfo[]>;
	/** Claude's plan limits, asked of the live session; null when it cannot say. Claude only. */
	usage?(): Promise<ClaudeUsage | null>;
	dispose(): void;
}

export type ChatOptions = {
	readonly workspaceId: string;
	readonly cwd: string;
	readonly agent: AgentKind;
	readonly model: string;
	readonly permission: string;
	/** Claude: "" sends none (the model default). Antigravity: low / medium / high. */
	readonly effort: string;
	readonly resume?: string;
};

export type SessionFactory = (
	options: ChatOptions,
	callbacks: {
		readonly onEvent: (event: UiEvent) => void;
		readonly onApproval: (request: ApprovalRequest) => void;
	},
) => AgentSession | { readonly error: string; readonly reason: string };

export type ChatEnvelope = { readonly chatId: string; readonly event: UiEvent };
export type ApprovalEnvelope = { readonly chatId: string; readonly request: ApprovalRequest };

/** `active` orders chats by when they were last opened or sent to, most recent highest. */
type Entry = { readonly options: ChatOptions; readonly session: AgentSession; readonly active: number };

export class ChatRegistry {
	readonly #chats = new Map<string, Entry>();
	readonly #closeListeners = new Set<(chatId: string) => void>();
	#activity = 0;

	constructor(
		readonly factory: SessionFactory,
		readonly emit: {
			readonly event: (envelope: ChatEnvelope) => void;
			readonly approval: (envelope: ApprovalEnvelope) => void;
		},
		readonly newId: () => string = randomUUID,
	) {}

	/** Open a chat. A failure to start is reported as the chat's first event. */
	create(options: ChatOptions): string {
		const chatId = this.newId();
		const made = this.factory(options, {
			onEvent: (event) => this.emit.event({ chatId, event }),
			onApproval: (request) => this.emit.approval({ chatId, request }),
		});
		if ("error" in made) {
			this.emit.event({
				chatId,
				event: { kind: "run-error", sessionId: "", reason: made.reason, message: made.error },
			});
			return chatId;
		}
		this.#chats.set(chatId, { options, session: made, active: (this.#activity += 1) });
		return chatId;
	}

	has(chatId: string): boolean {
		return this.#chats.has(chatId);
	}

	options(chatId: string): ChatOptions | undefined {
		return this.#chats.get(chatId)?.options;
	}

	send(chatId: string, text: string, images: readonly ChatImage[] = []): boolean {
		const entry = this.#chats.get(chatId);
		if (!entry) return false;
		this.#chats.set(chatId, { ...entry, active: (this.#activity += 1) });
		entry.session.send(text, images);
		return true;
	}

	stop(chatId: string): Promise<void> {
		return this.#chats.get(chatId)?.session.stop() ?? Promise.resolve();
	}

	approve(chatId: string, id: string, decision: ApprovalDecision): void {
		this.#chats.get(chatId)?.session.respondToApproval(id, decision);
	}

	/** The chat's options follow the switch, so anything reading them later (a /btw) sees the model in use. */
	setModel(chatId: string, model: string): Promise<void> {
		const entry = this.#chats.get(chatId);
		if (!entry) return Promise.resolve();
		this.#chats.set(chatId, { ...entry, options: { ...entry.options, model } });
		return entry.session.setModel(model);
	}

	/** Called with the id of every chat closed from now on; returns the unsubscribe. */
	onClose(listener: (chatId: string) => void): () => void {
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	setEffort(chatId: string, effort: string): Promise<void> {
		const entry = this.#chats.get(chatId);
		if (!entry) return Promise.resolve();
		this.#chats.set(chatId, { ...entry, options: { ...entry.options, effort } });
		return entry.session.setEffort(effort);
	}

	setPermissionMode(chatId: string, mode: string): Promise<void> {
		return this.#chats.get(chatId)?.session.setPermissionMode(mode) ?? Promise.resolve();
	}

	/** The agent's session id for a chat; "" when it has none yet or the chat is gone. */
	sessionId(chatId: string): string {
		return this.#chats.get(chatId)?.session.sessionId ?? "";
	}

	commands(chatId: string): Promise<SlashCommandInfo[]> {
		return this.#chats.get(chatId)?.session.commands() ?? Promise.resolve([]);
	}

	/**
	 * Claude's plan limits, from the most recently active Claude chat that can
	 * answer: one not started yet (no message sent) cannot, so the next is asked.
	 */
	async usage(): Promise<ClaudeUsage | null> {
		const claude = [...this.#chats.values()].filter((e) => e.options.agent === "claude").sort((a, b) => b.active - a.active);
		for (const entry of claude) {
			const usage = (await entry.session.usage?.()) ?? null;
			if (usage) return usage;
		}
		return null;
	}

	close(chatId: string): void {
		const entry = this.#chats.get(chatId);
		if (!entry) return;
		this.#chats.delete(chatId);
		entry.session.dispose();
		for (const listener of this.#closeListeners) listener(chatId);
	}

	closeWorkspace(workspaceId: string): void {
		for (const [chatId, entry] of this.#chats) {
			if (entry.options.workspaceId === workspaceId) this.close(chatId);
		}
	}

	disposeAll(): void {
		for (const chatId of [...this.#chats.keys()]) this.close(chatId);
	}
}
