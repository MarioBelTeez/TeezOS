/**
 * Convert Claude Code's SDK messages into the small set of events the UI draws.
 *
 * The renderer never sees a raw SDK message. Three reasons this layer exists:
 *
 *  - **Noise.** A run on this machine emits ~30KB of `hook_started` /
 *    `hook_response` before the first real message, plus envelope events
 *    (`message_start`, `content_block_start/stop`, `message_delta`,
 *    `system:status`) that carry nothing a card needs.
 *  - **Double text.** With `includePartialMessages` the same sentence arrives
 *    twice: once as `content_block_delta`s, then again as a complete
 *    `assistant` message. Rendering both prints it twice.
 *  - **Forward compatibility.** Unknown message types are dropped rather than
 *    thrown on, so a Claude Code release that adds an event cannot break the
 *    window.
 *
 * `push` takes one parsed message and returns zero or more UI events. It holds
 * only the small amount of state those rules require, plus the last context
 * reading for the turn's footer.
 *
 * **Subagents.** A Task call's subagent streams its own messages, each tagged
 * with `parent_tool_use_id` (the Task's `tool_use` id). Its tool calls keep
 * that parent so the window can nest them; its prose is not the answer to the
 * user, so it becomes `subagent-text` rather than `text`.
 */

/** Tokens in the model's context at the last top-level call, out of its window. */
export type ContextUse = { readonly used: number; readonly window: number };

export type UiEvent =
	| {
			readonly kind: "session-ready";
			readonly sessionId: string;
			readonly model: string;
			readonly permissionMode: string;
			readonly toolCount: number;
			readonly cwd: string;
			/** Slash commands this session accepts (skills, .claude/commands, built-ins). */
			readonly slashCommands: readonly string[];
	  }
	| { readonly kind: "text-delta"; readonly sessionId: string; readonly text: string }
	| { readonly kind: "text"; readonly sessionId: string; readonly text: string }
	| {
			readonly kind: "subagent-text";
			readonly sessionId: string;
			readonly parentToolUseId: string;
			readonly text: string;
	  }
	| {
			readonly kind: "tool-start";
			readonly sessionId: string;
			readonly toolUseId: string;
			readonly name: string;
			readonly input: Record<string, unknown>;
			/** The Task call whose subagent made this call; null at top level. */
			readonly parentToolUseId: string | null;
	  }
	| {
			readonly kind: "tool-end";
			readonly sessionId: string;
			readonly toolUseId: string;
			readonly isError: boolean;
			readonly content: string;
			readonly parentToolUseId: string | null;
	  }
	| {
			readonly kind: "turn-end";
			readonly sessionId: string;
			readonly ok: true;
			readonly text: string;
			readonly durationMs: number;
			readonly numTurns: number;
			readonly costUsd: number;
			/** Null when the run reported no usage or no context window. */
			readonly context: ContextUse | null;
	  }
	| {
			readonly kind: "compacted";
			readonly sessionId: string;
			readonly trigger: "manual" | "auto";
			readonly preTokens: number;
			readonly postTokens: number | null;
	  }
	| {
			readonly kind: "turn-cancelled";
			readonly sessionId: string;
			readonly durationMs: number;
	  }
	| {
			readonly kind: "run-error";
			readonly sessionId: string;
			readonly reason: string;
			readonly message: string;
	  }
	| {
			readonly kind: "rate-limit";
			readonly sessionId: string;
			readonly status: string;
			readonly window: string;
			readonly resetsAt: number;
	  };

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
	return typeof value === "object" && value !== null;
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Tool results arrive as a string or as content blocks; the card wants text. */
function flattenContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((part) => (isBag(part) && part["type"] === "text" ? str(part["text"]) : ""))
			.filter((text) => text.length > 0)
			.join("\n");
	}
	return "";
}

export class EventConverter {
	/** Last session id seen, for messages that omit it (stream events). */
	#sessionId = "";

	/**
	 * True once deltas have been emitted for the assistant message in flight.
	 * The completed `assistant` message that follows is then redundant text.
	 */
	#streamedText = false;

	/** The session's model from init; picks its entry out of `modelUsage`. */
	#model = "";

	/** Context tokens at the last top-level call; 0 until one reports usage. */
	#lastContext = 0;

	push(message: unknown): UiEvent[] {
		if (!isBag(message)) return [];

		const type = str(message["type"]);
		const sessionId = str(message["session_id"], this.#sessionId);
		if (sessionId) this.#sessionId = sessionId;
		const parentToolUseId = str(message["parent_tool_use_id"]) || null;

		switch (type) {
			case "system":
				return this.#system(message, sessionId);
			case "stream_event":
				return this.#streamEvent(message, sessionId, parentToolUseId);
			case "assistant":
				return this.#assistant(message, sessionId, parentToolUseId);
			case "user":
				return this.#user(message, sessionId, parentToolUseId);
			case "result":
				return this.#result(message, sessionId);
			case "rate_limit_event":
				return this.#rateLimit(message, sessionId);
			default:
				return [];
		}
	}

	#system(message: Bag, sessionId: string): UiEvent[] {
		const subtype = str(message["subtype"]);
		if (subtype === "compact_boundary") return this.#compacted(message, sessionId);
		// hook_started / hook_response / status carry nothing the UI draws.
		if (subtype !== "init") return [];

		this.#model = str(message["model"]);
		const tools = message["tools"];
		const commands = message["slash_commands"];
		return [
			{
				kind: "session-ready",
				sessionId,
				model: str(message["model"]),
				permissionMode: str(message["permissionMode"]),
				toolCount: Array.isArray(tools) ? tools.length : 0,
				cwd: str(message["cwd"]),
				slashCommands: Array.isArray(commands) ? commands.filter((c): c is string => typeof c === "string") : [],
			},
		];
	}

	#compacted(message: Bag, sessionId: string): UiEvent[] {
		const meta = message["compact_metadata"];
		if (!isBag(meta)) return [];
		const post = num(meta["post_tokens"]);
		// A turn that only compacts (/compact) makes no new call to read usage
		// from; without this its footer would report the size before compaction.
		this.#lastContext = post;
		return [
			{
				kind: "compacted",
				sessionId,
				trigger: meta["trigger"] === "manual" ? "manual" : "auto",
				preTokens: num(meta["pre_tokens"]),
				postTokens: post > 0 ? post : null,
			},
		];
	}

	#streamEvent(message: Bag, sessionId: string, parentToolUseId: string | null): UiEvent[] {
		// A subagent's deltas are not the answer; its complete text arrives as
		// subagent-text. Returning before the flag below also keeps its stream
		// from suppressing the main answer's completed text.
		if (parentToolUseId) return [];
		const event = message["event"];
		if (!isBag(event)) return [];
		if (str(event["type"]) === "message_start") this.#streamedText = false;
		if (str(event["type"]) !== "content_block_delta") return [];

		const delta = event["delta"];
		if (!isBag(delta) || str(delta["type"]) !== "text_delta") return [];

		const text = str(delta["text"]);
		if (!text) return [];

		this.#streamedText = true;
		return [{ kind: "text-delta", sessionId, text }];
	}

	#assistant(message: Bag, sessionId: string, parentToolUseId: string | null): UiEvent[] {
		const inner = message["message"];
		if (!parentToolUseId && isBag(inner)) this.#recordUsage(inner["usage"]);
		const content = isBag(inner) ? inner["content"] : undefined;
		if (!Array.isArray(content)) return [];

		const events: UiEvent[] = [];
		for (const block of content) {
			if (!isBag(block)) continue;

			if (block["type"] === "tool_use") {
				const input = block["input"];
				events.push({
					kind: "tool-start",
					sessionId,
					toolUseId: str(block["id"]),
					name: str(block["name"]),
					input: isBag(input) ? input : {},
					parentToolUseId,
				});
				continue;
			}

			if (block["type"] === "text" && parentToolUseId) {
				const text = str(block["text"]);
				if (text) events.push({ kind: "subagent-text", sessionId, parentToolUseId, text });
				continue;
			}

			// Already shown delta by delta; emitting it again prints it twice.
			if (block["type"] === "text" && !this.#streamedText) {
				const text = str(block["text"]);
				if (text) events.push({ kind: "text", sessionId, text });
			}
		}
		return events;
	}

	/**
	 * Everything the model read on this call: fresh input plus both cache
	 * kinds. The last top-level call wins; a subagent has a context of its own.
	 * A call reporting nothing (a synthetic error message) keeps the last reading.
	 */
	#recordUsage(usage: unknown): void {
		if (!isBag(usage)) return;
		const used =
			num(usage["input_tokens"]) + num(usage["cache_read_input_tokens"]) + num(usage["cache_creation_input_tokens"]);
		if (used > 0) this.#lastContext = used;
	}

	/**
	 * The session model's window from `modelUsage` (keys can carry suffixes,
	 * hence "includes"); failing a match, the largest window reported.
	 */
	#contextWindow(modelUsage: unknown): number {
		if (!isBag(modelUsage)) return 0;
		let largest = 0;
		for (const [key, entry] of Object.entries(modelUsage)) {
			if (!isBag(entry)) continue;
			const window = num(entry["contextWindow"]);
			if (this.#model && key.includes(this.#model) && window > 0) return window;
			largest = Math.max(largest, window);
		}
		return largest;
	}

	#context(message: Bag): ContextUse | null {
		const window = this.#contextWindow(message["modelUsage"]);
		return this.#lastContext > 0 && window > 0 ? { used: this.#lastContext, window } : null;
	}

	#user(message: Bag, sessionId: string, parentToolUseId: string | null): UiEvent[] {
		const inner = message["message"];
		const content = isBag(inner) ? inner["content"] : undefined;
		if (!Array.isArray(content)) return [];

		const events: UiEvent[] = [];
		for (const block of content) {
			if (!isBag(block) || block["type"] !== "tool_result") continue;
			events.push({
				kind: "tool-end",
				sessionId,
				toolUseId: str(block["tool_use_id"]),
				isError: block["is_error"] === true,
				content: flattenContent(block["content"]),
				parentToolUseId,
			});
		}
		return events;
	}

	#result(message: Bag, sessionId: string): UiEvent[] {
		this.#streamedText = false;
		const subtype = str(message["subtype"]);

		if (subtype !== "success") {
			// Pressing Stop comes back as a failure: `error_during_execution`,
			// `is_error: true`, no result text. Only `terminal_reason` says it
			// was a cancellation — and a cancel the user asked for must not be
			// dressed up as an error.
			if (str(message["terminal_reason"]) === "aborted_streaming") {
				return [
					{
						kind: "turn-cancelled",
						sessionId,
						durationMs: num(message["duration_ms"]),
					},
				];
			}

			return [
				{
					kind: "run-error",
					sessionId,
					reason: subtype || "unknown",
					message: str(message["result"], subtype || "The run did not finish."),
				},
			];
		}

		return [
			{
				kind: "turn-end",
				sessionId,
				ok: true,
				text: str(message["result"]),
				durationMs: num(message["duration_ms"]),
				numTurns: num(message["num_turns"]),
				costUsd: num(message["total_cost_usd"]),
				context: this.#context(message),
			},
		];
	}

	#rateLimit(message: Bag, sessionId: string): UiEvent[] {
		const info = message["rate_limit_info"];
		if (!isBag(info)) return [];

		return [
			{
				kind: "rate-limit",
				sessionId,
				status: str(info["status"]),
				window: str(info["rateLimitType"]),
				resetsAt: num(info["resetsAt"]),
			},
		];
	}
}
