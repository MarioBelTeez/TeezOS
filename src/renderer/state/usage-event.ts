import type { AgentKind } from "../../main/agents/registry.ts";
import type { UiEvent } from "../../main/claude/events.ts";
import type { Usage } from "./agents.ts";

/** A rate-limit event as Claude's plan usage, when it came from a Claude chat; other agents' limits are their own. */
export function claudeUsageOf(event: UiEvent, agent: AgentKind | undefined, now: number = Date.now()): Usage | null {
	if (event.kind !== "rate-limit" || agent !== "claude") return null;
	return { status: event.status, window: event.window, resetsAt: event.resetsAt, seenAt: now };
}
