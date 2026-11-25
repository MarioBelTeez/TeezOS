import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiEvent } from "../claude/events.ts";

/**
 * Watches an Antigravity subagent's `transcript.jsonl` on disk and turns each
 * planner step into the same `tool-start` / `tool-end` / `subagent-text` events
 * Claude subagents emit, so both the chat card and the Agents tree show live
 * progress while the subagent runs in the background.
 */

type Bag = Record<string, unknown>;
const isBag = (value: unknown): value is Bag => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_POLL_MS = 500;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;

export type SubagentLaunch = {
	readonly conversationId: string;
	readonly logPath: string;
};

export type SubagentWatcherLike = {
	stop(emitCancelled?: boolean): void;
};

export type AgySubagentWatcherOptions = {
	readonly parentToolUseId: string;
	readonly sessionId: string;
	readonly logPath: string;
	readonly onEvent: (event: UiEvent) => void;
	readonly onDone?: () => void;
	readonly pollMs?: number;
	readonly idleTimeoutMs?: number;
	readonly now?: () => number;
};

function defaultTranscriptPath(conversationId: string): string {
	return join(homedir(), ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}

function tryParseBag(text: string): Bag | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return isBag(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Extracts the launched subagent's conversation id and transcript path from
 * `invoke_subagent`'s tool output. Returns null when the output does not carry
 * a valid UUID conversation id.
 */
export function parseSubagentLaunch(content: string): SubagentLaunch | null {
	const trimmed = content.trim();
	if (!trimmed) return null;

	let bag = tryParseBag(trimmed);
	if (!bag) {
		const first = trimmed.indexOf("{");
		const last = trimmed.lastIndexOf("}");
		if (first >= 0 && last > first) {
			bag = tryParseBag(trimmed.slice(first, last + 1));
		}
	}

	let conversationId = bag ? str(bag["conversationId"]).trim() : "";
	let logAbsoluteUri = bag ? str(bag["logAbsoluteUri"]).trim() : "";

	if (!conversationId) {
		conversationId = /"conversationId"\s*:\s*"([0-9a-f-]{36})"/i.exec(trimmed)?.[1] ?? "";
	}
	if (!logAbsoluteUri) {
		logAbsoluteUri = /"logAbsoluteUri"\s*:\s*"([^"]+)"/i.exec(trimmed)?.[1] ?? "";
	}

	if (!UUID_RE.test(conversationId)) return null;

	if (logAbsoluteUri) {
		try {
			const resolved = fileURLToPath(logAbsoluteUri);
			if (resolved) return { conversationId, logPath: resolved };
		} catch {
			// Fall back to the standard brain transcript location on invalid URIs.
		}
	}

	return { conversationId, logPath: defaultTranscriptPath(conversationId) };
}

/**
 * In Antigravity's `transcript.jsonl`, `tool_calls[].args` values are often
 * JSON-encoded strings (e.g. `"\"C:\\\\Users\\\\...\""`). Unwraps JSON strings,
 * objects and arrays while leaving plain values intact.
 */
export function unwrapTranscriptArgs(raw: unknown): Record<string, unknown> {
	if (!isBag(raw)) return {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string") {
			const trimmed = value.trim();
			const looksJson =
				(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
				(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
				(trimmed.startsWith("[") && trimmed.endsWith("]"));
			if (looksJson) {
				try {
					out[key] = JSON.parse(trimmed);
					continue;
				} catch {
					// Keep raw string when it is not valid JSON.
				}
			}
		}
		out[key] = value;
	}
	return out;
}

function firstLine(value: unknown): string {
	if (typeof value !== "string") return "";
	for (const line of value.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

/**
 * Parses one JSONL line from a subagent's `transcript.jsonl`, deduplicating by
 * `step_index`. Returns any UI events emitted by the step and whether the
 * subagent has completed its work.
 */
export function parseTranscriptLine(
	line: string,
	parentToolUseId: string,
	sessionId: string,
	seenSteps: Set<number>,
): { readonly events: UiEvent[]; readonly finished: boolean } {
	const trimmed = line.trim();
	if (!trimmed) return { events: [], finished: false };
	const parsed = tryParseBag(trimmed);
	if (!parsed) return { events: [], finished: false };

	const stepIndex = parsed["step_index"];
	if (typeof stepIndex !== "number" || !Number.isFinite(stepIndex)) return { events: [], finished: false };
	if (seenSteps.has(stepIndex)) return { events: [], finished: false };
	seenSteps.add(stepIndex);

	if (str(parsed["type"]) !== "PLANNER_RESPONSE") return { events: [], finished: false };

	const events: UiEvent[] = [];
	let finished = false;
	const toolCalls = parsed["tool_calls"];

	if (Array.isArray(toolCalls) && toolCalls.length > 0) {
		toolCalls.forEach((tc, idx) => {
			if (!isBag(tc)) return;
			const name = str(tc["name"]);
			if (!name) return;
			const input = unwrapTranscriptArgs(tc["args"]);
			events.push({
				kind: "tool-start",
				sessionId,
				toolUseId: `${parentToolUseId}:sub:${stepIndex}:${idx}`,
				name,
				input,
				parentToolUseId,
			});
			if (name === "send_message") {
				const summary = firstLine(str(input["Message"]) || str(input["message"]));
				if (summary) {
					events.push({
						kind: "subagent-text",
						sessionId,
						parentToolUseId,
						text: summary,
					});
				}
				finished = true;
			}
		});
	} else if (str(parsed["status"]) === "DONE") {
		const summary = firstLine(str(parsed["response"]) || str(parsed["content"]));
		if (summary) {
			events.push({
				kind: "subagent-text",
				sessionId,
				parentToolUseId,
				text: summary,
			});
			finished = true;
		}
	}

	return { events, finished };
}

export class AgySubagentWatcher implements SubagentWatcherLike {
	readonly #opts: AgySubagentWatcherOptions;
	readonly #now: () => number;
	readonly #idleTimeoutMs: number;
	readonly #seenSteps = new Set<number>();
	#processedLines = 0;
	#openTools: string[] = [];
	#lastSummary = "";
	#lastActivityAt: number;
	#stopped = false;
	#timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: AgySubagentWatcherOptions) {
		this.#opts = options;
		this.#now = options.now ?? Date.now;
		this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.#lastActivityAt = this.#now();

		const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
		const timer = setInterval(() => this.#poll(), pollMs);
		timer.unref?.();
		this.#timer = timer;

		queueMicrotask(() => {
			if (!this.#stopped) this.#poll();
		});
	}

	stop(emitCancelled = false): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
		if (emitCancelled) {
			this.#closeOpenTools(true);
			this.#opts.onEvent({
				kind: "tool-end",
				sessionId: this.#opts.sessionId,
				toolUseId: this.#opts.parentToolUseId,
				isError: true,
				content: "Subagent cancelled.",
				parentToolUseId: null,
			});
		}
		this.#opts.onDone?.();
	}

	#closeOpenTools(isError: boolean): void {
		if (this.#openTools.length === 0) return;
		const open = this.#openTools;
		this.#openTools = [];
		for (const toolUseId of open) {
			this.#opts.onEvent({
				kind: "tool-end",
				sessionId: this.#opts.sessionId,
				toolUseId,
				isError,
				content: "",
				parentToolUseId: this.#opts.parentToolUseId,
			});
		}
	}

	#finish(content: string, isError: boolean): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
		this.#closeOpenTools(isError);
		this.#opts.onEvent({
			kind: "tool-end",
			sessionId: this.#opts.sessionId,
			toolUseId: this.#opts.parentToolUseId,
			isError,
			content,
			parentToolUseId: null,
		});
		this.#opts.onDone?.();
	}

	#poll(): void {
		if (this.#stopped) return;
		const now = this.#now();
		let raw: string;
		try {
			raw = readFileSync(this.#opts.logPath, "utf8");
		} catch {
			if (now - this.#lastActivityAt >= this.#idleTimeoutMs) {
				this.#finish(this.#lastSummary || "Subagent timed out.", false);
			}
			return;
		}

		const lines = raw.split(/\r?\n/);
		if (lines.length < this.#processedLines) this.#processedLines = 0;

		let progressed = false;
		for (let i = this.#processedLines; i < lines.length; i += 1) {
			const line = lines[i] ?? "";
			const isLast = i === lines.length - 1;
			if (!line.trim()) {
				if (!isLast) this.#processedLines = i + 1;
				continue;
			}
			// Wait for a partial trailing line to finish writing before advancing past it.
			if (isLast && !tryParseBag(line.trim())) break;

			this.#processedLines = i + 1;
			progressed = true;

			const { events, finished } = parseTranscriptLine(line, this.#opts.parentToolUseId, this.#opts.sessionId, this.#seenSteps);
			if (events.length > 0) {
				this.#closeOpenTools(false);
				for (const event of events) {
					if (event.kind === "tool-start") this.#openTools.push(event.toolUseId);
					if (event.kind === "subagent-text" && event.text) this.#lastSummary = event.text;
					this.#opts.onEvent(event);
				}
			}
			if (finished) {
				this.#finish(this.#lastSummary || "Subagent finished.", false);
				return;
			}
		}

		if (progressed) {
			this.#lastActivityAt = now;
		} else if (now - this.#lastActivityAt >= this.#idleTimeoutMs) {
			this.#finish(this.#lastSummary || "Subagent timed out.", false);
		}
	}
}
