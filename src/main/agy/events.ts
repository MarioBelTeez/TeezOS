import type { UiEvent } from "../claude/events.ts";

/**
 * Convert Antigravity's stream-json into the same events a Claude chat emits,
 * so one chat UI draws both.
 *
 * agy reports a run as numbered steps (`step_update`): the user's input, the
 * agent's responses (streamed as `text_delta`s), and tools moving from ACTIVE
 * to DONE or ERROR. A final `result` carries the status and, when headless
 * mode had to refuse something, a `denied_actions` list — the one case where
 * an empty reply needs explaining, because the run itself still "succeeded".
 */

type Bag = Record<string, unknown>;
const isBag = (value: unknown): value is Bag => typeof value === "object" && value !== null;
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function agyContextWindow(model: string): number {
	const id = model.toLowerCase();
	if (id.includes("claude") || id.includes("opus") || id.includes("sonnet") || id.includes("gpt")) return 200_000;
	return 1_000_000;
}

export class AgyEventConverter {
	#conversationId = "";
	#lastStepTokens = 0;
	readonly #model: string;

	constructor(options: { readonly model: string }) {
		this.#model = options.model;
	}

	get conversationId(): string {
		return this.#conversationId;
	}

	push(message: unknown): UiEvent[] {
		if (!isBag(message)) return [];
		switch (message["event"]) {
			case "init":
				return this.#init(message);
			case "step_update":
				return this.#step(message["step_update"]);
			case "result":
				return this.#result(message["result"]);
			default:
				return [];
		}
	}

	#init(message: Bag): UiEvent[] {
		this.#conversationId = str(message["conversation_id"], this.#conversationId);
		const init = isBag(message["init"]) ? message["init"] : {};
		const tools = init["tools"];
		return [
			{
				kind: "session-ready",
				sessionId: this.#conversationId,
				model: this.#model || "agy default",
				permissionMode: str(init["permission_mode"]),
				toolCount: Array.isArray(tools) ? tools.length : 0,
				cwd: str(init["cwd"]),
				slashCommands: [],
			},
		];
	}

	#step(step: unknown): UiEvent[] {
		if (!isBag(step)) return [];
		const sessionId = str(step["conversation_id"], this.#conversationId);
		if (sessionId) this.#conversationId = sessionId;
		const type = str(step["step_type"]);
		const state = str(step["state"]);

		if (type === "agent_response") {
			const usage = isBag(step["usage"]) ? step["usage"] : null;
			const stepTokens = usage ? num(usage["total_tokens"]) : 0;
			if (stepTokens > 0) this.#lastStepTokens = stepTokens;
			const text = str(step["text_delta"]);
			return text ? [{ kind: "text-delta", sessionId, text }] : [];
		}

		if (type === "tool") {
			const info = isBag(step["tool_info"]) ? step["tool_info"] : {};
			const toolUseId = `${sessionId}#${num(step["step_index"])}`;
			const name = str(step["tool_name"], str(info["name"]));
			if (state === "ACTIVE") {
				const parameters = info["parameters"];
				return [{ kind: "tool-start", sessionId, toolUseId, name, input: isBag(parameters) ? parameters : {}, parentToolUseId: null }];
			}
			const error = isBag(info["error"]) ? str(info["error"]["message"]) : "";
			return [
				{
					kind: "tool-end",
					sessionId,
					toolUseId,
					isError: state !== "DONE",
					content: error || str(info["output"]) || (state === "DONE" ? "" : state.toLowerCase()),
					// agy's stream-json does not say which steps a subagent ran.
					parentToolUseId: null,
				},
			];
		}

		return [];
	}

	#result(result: unknown): UiEvent[] {
		if (!isBag(result)) return [];
		const sessionId = str(result["conversation_id"], this.#conversationId);
		if (sessionId) this.#conversationId = sessionId;
		const status = str(result["status"]);

		if (status !== "SUCCESS") {
			return [
				{
					kind: "run-error",
					sessionId,
					reason: "agy-error",
					message: str(result["error"]) || str(result["response"]) || `Antigravity ended with ${status || "no status"}.`,
				},
			];
		}

		const usage = isBag(result["usage"]) ? result["usage"] : null;
		const usedTokens = this.#lastStepTokens > 0 ? this.#lastStepTokens : usage ? num(usage["total_tokens"]) : 0;

		const events: UiEvent[] = [
			{
				kind: "turn-end",
				sessionId,
				ok: true,
				text: str(result["response"]),
				durationMs: Math.round(num(result["duration_seconds"]) * 1000),
				numTurns: num(result["num_turns"]),
				// Antigravity runs on the Google account's quota, not per-token billing.
				costUsd: 0,
				context: usedTokens > 0 ? { used: usedTokens, window: agyContextWindow(this.#model) } : null,
			},
		];

		const denied = result["denied_actions"];
		if (Array.isArray(denied) && denied.length > 0) {
			const names = denied
				.map((action) => (isBag(action) ? str(action["display_name"], str(action["action"])) : ""))
				.filter(Boolean);
			events.push({
				kind: "run-error",
				sessionId,
				reason: "agy-denied",
				message: `Antigravity needed permission for: ${names.join(", ") || "an action"}. A headless run cannot ask, so it was refused. Switch this chat's mode to Full auto, or add an allow rule in Antigravity's settings.`,
			});
		}
		return events;
	}
}
