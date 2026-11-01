import type { ContextUse, UiEvent } from "../claude/events.ts";

/**
 * Codex app-server notifications → the chat's events (the same ones Claude
 * and Antigravity produce). Field names follow the generated protocol types in
 * ./protocol/v2 and the recordings in ./__fixtures__. Anything unknown or
 * malformed converts to nothing: a newer Codex adding notifications must not
 * break a chat.
 */

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A file change as an Edit tool's input: the first path for the card's title, every path, and Codex's diff. */
export function fileChangeInput(changes: unknown): Record<string, unknown> | null {
	if (!Array.isArray(changes)) return null;
	const files = changes.filter(isBag).map((change) => ({ path: str(change["path"]), diff: str(change["diff"]) })).filter((c) => c.path);
	if (files.length === 0) return null;
	if (files.length === 1) return { file_path: files[0]!.path, diff: files[0]!.diff };
	return {
		file_path: `${files.length} files`,
		files: files.map((f) => f.path),
		diff: files.map((f) => `--- ${f.path}\n${f.diff}`).join("\n"),
	};
}

export class CodexEventConverter {
	readonly #sessionId: () => string;
	readonly #now: () => number;
	#turnStartedAt = 0;
	#lastText = "";
	#context: ContextUse | null = null;

	constructor(sessionId: () => string, now: () => number = Date.now) {
		this.#sessionId = sessionId;
		this.#now = now;
	}

	/** Zero or more chat events for one notification; unknown methods give []. */
	convert(method: string, params: unknown): UiEvent[] {
		if (!isBag(params)) return [];
		const sessionId = this.#sessionId();
		switch (method) {
			case "turn/started":
				this.#turnStartedAt = this.#now();
				this.#lastText = "";
				return [];
			case "item/agentMessage/delta": {
				const delta = str(params["delta"]);
				return delta ? [{ kind: "text-delta", sessionId, text: delta }] : [];
			}
			case "item/started":
				return this.#itemStarted(params["item"], sessionId);
			case "item/completed":
				return this.#itemCompleted(params["item"], sessionId);
			case "thread/tokenUsage/updated":
				this.#context = this.#contextOf(params["tokenUsage"]);
				return [];
			case "turn/completed":
				return this.#turnCompleted(params["turn"], sessionId);
			case "error": {
				if (params["willRetry"] === true) return [];
				const error = params["error"];
				return [{ kind: "run-error", sessionId, reason: "codex-error", message: isBag(error) ? str(error["message"]) || "Codex reported an error." : "Codex reported an error." }];
			}
			case "account/rateLimits/updated":
				return this.#rateLimit(params["rateLimits"], sessionId);
			default:
				return [];
		}
	}

	#itemStarted(item: unknown, sessionId: string): UiEvent[] {
		if (!isBag(item)) return [];
		const id = str(item["id"]);
		if (!id) return [];
		if (item["type"] === "commandExecution") {
			return [{ kind: "tool-start", sessionId, toolUseId: id, name: "Bash", input: { command: str(item["command"]), cwd: str(item["cwd"]) }, parentToolUseId: null }];
		}
		if (item["type"] === "fileChange") {
			const input = fileChangeInput(item["changes"]);
			return input ? [{ kind: "tool-start", sessionId, toolUseId: id, name: "Edit", input, parentToolUseId: null }] : [];
		}
		return [];
	}

	#itemCompleted(item: unknown, sessionId: string): UiEvent[] {
		if (!isBag(item)) return [];
		const id = str(item["id"]);
		if (item["type"] === "agentMessage") {
			const text = str(item["text"]);
			if (!text) return [];
			this.#lastText = text;
			return [{ kind: "text", sessionId, text }];
		}
		if (!id || (item["type"] !== "commandExecution" && item["type"] !== "fileChange")) return [];
		const status = str(item["status"]);
		const isError = status !== "completed";
		const output = str(item["aggregatedOutput"]);
		const content = status === "declined" ? "Declined: it did not run." : output || (isError ? `Ended: ${status || "unknown"}` : "");
		return [{ kind: "tool-end", sessionId, toolUseId: id, isError, content, parentToolUseId: null }];
	}

	#turnCompleted(turn: unknown, sessionId: string): UiEvent[] {
		if (!isBag(turn)) return [];
		const durationMs = num(turn["durationMs"]) ?? Math.max(0, this.#now() - this.#turnStartedAt);
		switch (turn["status"]) {
			case "completed":
				return [{ kind: "turn-end", sessionId, ok: true, text: this.#lastText, durationMs, numTurns: 1, costUsd: 0, context: this.#context }];
			case "interrupted":
				return [{ kind: "turn-cancelled", sessionId, durationMs }];
			case "failed": {
				const error = turn["error"];
				return [{ kind: "run-error", sessionId, reason: "codex-turn-failed", message: isBag(error) ? str(error["message"]) || "The turn failed." : "The turn failed." }];
			}
			default:
				return [];
		}
	}

	/** The context in use after the last request: that request's input tokens, against the model's window. */
	#contextOf(usage: unknown): ContextUse | null {
		if (!isBag(usage) || !isBag(usage["last"])) return null;
		const used = num(usage["last"]["inputTokens"]);
		const window = num(usage["modelContextWindow"]);
		return used !== null && window !== null && window > 0 ? { used, window } : null;
	}

	/** Only the cap being reached is an event; Codex also sends its usage after every turn. */
	#rateLimit(snapshot: unknown, sessionId: string): UiEvent[] {
		if (!isBag(snapshot)) return [];
		const primary = isBag(snapshot["primary"]) ? snapshot["primary"] : null;
		const reached = snapshot["rateLimitReachedType"] != null || (primary !== null && (num(primary["usedPercent"]) ?? 0) >= 100);
		if (!reached) return [];
		return [{ kind: "rate-limit", sessionId, status: "rejected", window: str(snapshot["limitId"]) || "codex", resetsAt: (primary && num(primary["resetsAt"])) || 0 }];
	}
}
