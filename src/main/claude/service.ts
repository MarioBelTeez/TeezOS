import { randomUUID } from "node:crypto";
import { EventConverter, type UiEvent } from "./events.ts";
import type { ChatImage } from "../../shared/images.ts";
import type { SlashCommandInfo } from "../agents/registry.ts";
import { normaliseUsage, type ClaudeUsage } from "../../shared/usage.ts";

/**
 * One chat = one live Claude Code session.
 *
 * Streaming input matters for more than follow-up messages: `interrupt()` and
 * `setPermissionMode()` only exist in streaming mode, so Stop and the mode
 * switch depend on holding the input open rather than starting a fresh query
 * per message.
 *
 * The SDK enters through `deps.query`, which keeps this class testable without
 * spending quota — the tests drive it with messages recorded from real runs.
 */

type ContentBlock =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string } };

export type SdkUserMessage = {
	readonly type: "user";
	readonly message: { readonly role: "user"; readonly content: string | readonly ContentBlock[] };
	readonly parent_tool_use_id: null;
};

export type QueryParams = {
	/** A stream for a chat (Stop and the mode switch need one); a string for a one-off question. */
	readonly prompt: AsyncIterable<SdkUserMessage> | string;
	readonly options: Record<string, unknown>;
};

export type QueryHandle = AsyncGenerator<unknown, void> & {
	interrupt?: () => Promise<unknown>;
	/** Ends the query and its CLI process. */
	close?: () => void;
	setPermissionMode?: (mode: string) => Promise<void>;
	setModel?: (model?: string) => Promise<void>;
	/** The SDK's mid-session settings layer; effort changes go through `effortLevel`. */
	applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>;
	supportedCommands?: () => Promise<{ name: string; description: string; argumentHint: string }[]>;
	/** Experimental in the SDK, and may vanish: always optional here. */
	usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (opts?: { skipBehaviors?: boolean }) => Promise<unknown>;
};

/** A usage answer slower than this is given up on; the window asks again later. */
const USAGE_TIMEOUT_MS = 10_000;

export type QueryFn = (params: QueryParams) => QueryHandle;

export type ApprovalDecision = "allow" | "deny";

export type ApprovalRequest = {
	readonly id: string;
	readonly toolName: string;
	readonly input: Record<string, unknown>;
};

type PermissionResult =
	| { readonly behavior: "allow"; readonly updatedInput?: Record<string, unknown> }
	| { readonly behavior: "deny"; readonly message: string };

export type SessionDeps = {
	readonly query: QueryFn;
	/** The real executable, from the locator — never npm's shim. */
	readonly claudePath: string;
	readonly cwd: string;
	readonly onEvent: (event: UiEvent) => void;
	readonly onApproval: (request: ApprovalRequest) => void;
	readonly resume?: string;
	readonly permissionMode?: string;
	/** "" or absent means the account's default model. */
	readonly model?: string;
	/** "" or absent sends no effort: the model's own default. */
	readonly effort?: string;
	readonly newId?: () => string;
};

/**
 * An async iterable the session can push into while the CLI reads from it.
 * One waiter at a time, which is all a single session needs.
 */
class PushStream implements AsyncIterable<SdkUserMessage> {
	#queue: SdkUserMessage[] = [];
	#waiting: ((result: IteratorResult<SdkUserMessage>) => void) | null = null;
	#closed = false;

	push(message: SdkUserMessage): void {
		if (this.#closed) return;
		const waiter = this.#waiting;
		if (waiter) {
			this.#waiting = null;
			waiter({ value: message, done: false });
			return;
		}
		this.#queue.push(message);
	}

	close(): void {
		this.#closed = true;
		const waiter = this.#waiting;
		if (waiter) {
			this.#waiting = null;
			waiter({ value: undefined, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<SdkUserMessage> {
		return {
			next: (): Promise<IteratorResult<SdkUserMessage>> => {
				const queued = this.#queue.shift();
				if (queued) return Promise.resolve({ value: queued, done: false });
				if (this.#closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => {
					this.#waiting = resolve;
				});
			},
		};
	}
}

export class ClaudeSession {
	readonly #deps: SessionDeps;
	readonly #input = new PushStream();
	readonly #converter = new EventConverter();
	readonly #pending = new Map<string, (result: PermissionResult) => void>();
	/**
	 * The CLI's own stderr, kept only until a turn ends.
	 *
	 * A failure on the user's machine showed a card reading just
	 * "error_during_execution": Claude Code had died before creating a session,
	 * so its own logs held nothing, and the only account of what happened went
	 * to a stderr nobody was reading.
	 */
	#stderr: string[] = [];
	#handle: QueryHandle | null = null;
	#sessionId = "";
	#model: string;
	#effort: string;
	#permissionMode: string;

	constructor(deps: SessionDeps) {
		this.#deps = deps;
		this.#model = deps.model ?? "";
		this.#effort = deps.effort ?? "";
		this.#permissionMode = deps.permissionMode ?? "default";
	}

	/** The id Claude Code gave this session, once it has reported one. */
	get sessionId(): string {
		return this.#sessionId;
	}

	send(text: string, images: readonly ChatImage[] = []): void {
		if (!this.#handle) this.#start();
		const content: string | ContentBlock[] =
			images.length === 0
				? text
				: [
						...images.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mediaType, data: image.data } })),
						// An image on its own needs no words; an empty text block is an API error.
						...(text ? [{ type: "text" as const, text }] : []),
					];
		this.#input.push({
			type: "user",
			message: { role: "user", content },
			parent_tool_use_id: null,
		});
	}

	/** Settle an APPROVE / DENY (or AskUserQuestion) card. Unknown ids are stale clicks; ignore them. */
	respondToApproval(id: string, decision: ApprovalDecision, updatedInput?: Record<string, unknown>): void {
		const resolve = this.#pending.get(id);
		if (!resolve) return;
		this.#pending.delete(id);
		if (decision === "allow") {
			resolve(updatedInput ? { behavior: "allow", updatedInput } : { behavior: "allow" });
			return;
		}
		resolve({ behavior: "deny", message: "Denied in TeezOS." });
	}

	/** Stop the current turn. Interrupting keeps the session alive to resume. */
	async stop(): Promise<void> {
		await this.#handle?.interrupt?.();
	}

	async setPermissionMode(mode: string): Promise<void> {
		this.#permissionMode = mode;
		await this.#handle?.setPermissionMode?.(mode);
	}

	/** Switch model mid-session; before the first message it applies at start. */
	async setModel(model: string): Promise<void> {
		this.#model = model;
		await this.#handle?.setModel?.(model || undefined);
	}

	/**
	 * Switch effort mid-session (the next request uses it); before the first
	 * message it applies at start. "" goes back to the model's default.
	 */
	async setEffort(effort: string): Promise<void> {
		this.#effort = effort;
		await this.#handle?.applyFlagSettings?.({ effortLevel: effort || null });
	}

	/**
	 * The slash commands this session accepts, with the descriptions and
	 * argument hints init's bare name list lacks. Empty until the first
	 * message starts the session: only a live query can be asked.
	 */
	async commands(): Promise<SlashCommandInfo[]> {
		try {
			const commands = (await this.#handle?.supportedCommands?.()) ?? [];
			return commands.map(({ name, description, argumentHint }) => ({ name, description, argumentHint }));
		} catch {
			// A query that ended or failed cannot be asked; the menu then shows
			// TeezAI's own commands rather than an error.
			return [];
		}
	}

	/**
	 * Claude's plan limits (5-hour, weekly, per model), read from the live
	 * query. Null before the first message (no query yet), when the SDK lacks
	 * the method, throws, answers in a shape not understood, or takes too long.
	 */
	async usage(): Promise<ClaudeUsage | null> {
		const ask = this.#handle?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
		if (!this.#handle || !ask) return null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), USAGE_TIMEOUT_MS);
		});
		try {
			// skipBehaviors: only the limits are wanted, not a scan of a week of local transcripts.
			const raw = await Promise.race([ask.call(this.#handle, { skipBehaviors: true }), timeout]);
			return normaliseUsage(raw);
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Close the session. Anything still waiting on a click is denied — a
	 * promise nobody can answer would hang the CLI until it timed out.
	 */
	dispose(): void {
		for (const [id, resolve] of this.#pending) {
			this.#pending.delete(id);
			resolve({ behavior: "deny", message: "The session closed before you answered." });
		}
		this.#input.close();
	}

	#start(): void {
		const options: Record<string, unknown> = {
			cwd: this.#deps.cwd,
			pathToClaudeCodeExecutable: this.#deps.claudePath,
			// Load the user's own CLAUDE.md, skills, hooks and MCP servers, so
			// the app behaves like their terminal rather than a bare agent.
			settingSources: ["user", "project", "local"],
			includePartialMessages: true,
			permissionMode: this.#permissionMode,
			canUseTool: this.#canUseTool,
			stderr: (data: string) => this.#recordStderr(data),
		};
		if (this.#deps.resume !== undefined) options["resume"] = this.#deps.resume;
		if (this.#model) options["model"] = this.#model;
		if (this.#effort) options["effort"] = this.#effort;

		this.#handle = this.#deps.query({ prompt: this.#input, options });
		void this.#drain(this.#handle);
	}

	/** Keep the tail; a crash loop could otherwise print megabytes. */
	#recordStderr(data: string): void {
		for (const line of data.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed) this.#stderr.push(trimmed);
		}
		if (this.#stderr.length > 20) this.#stderr = this.#stderr.slice(-20);
	}

	/** Attach what the CLI said to an error the user is about to read. */
	#explain(message: string): string {
		if (this.#stderr.length === 0) return message;
		return `${message}\n\n${this.#stderr.join("\n")}`;
	}

	async #drain(handle: QueryHandle): Promise<void> {
		try {
			for await (const message of handle) {
				for (const event of this.#converter.push(message)) {
					if (event.kind === "session-ready") this.#sessionId = event.sessionId;
					// A turn that finished has nothing to explain; drop the noise
					// so it cannot surface against some later failure.
					if (event.kind === "turn-end") this.#stderr = [];
					this.#deps.onEvent(
						event.kind === "run-error"
							? { ...event, message: this.#explain(event.message) }
							: event,
					);
				}
			}
		} catch (error) {
			this.#deps.onEvent({
				kind: "run-error",
				sessionId: this.#sessionId,
				reason: "sdk-error",
				message: this.#explain(
					error instanceof Error ? error.message : String(error),
				),
			});
		}
	}

	readonly #canUseTool = (
		toolName: string,
		input: Record<string, unknown>,
		options: { signal: AbortSignal },
	): Promise<PermissionResult> =>
		new Promise<PermissionResult>((resolve) => {
			const id = (this.#deps.newId ?? randomUUID)();
			this.#pending.set(id, resolve);

			options.signal.addEventListener("abort", () => {
				if (!this.#pending.delete(id)) return;
				resolve({ behavior: "deny", message: "The run was cancelled." });
			});

			this.#deps.onApproval({ id, toolName, input });
		});
}
