import type { AgentKind } from "../../main/agents/registry.ts";
import type { ModelChoice } from "../../shared/models.ts";
import { agentName } from "./agent-options.ts";
import { buildHandover } from "./handover.ts";
import type { Card } from "./reduce.ts";

/**
 * What picking a model does. Within one agent the chat keeps going on the new
 * model (even mid-turn: the change applies to the next message). Across
 * agents the conversation cannot move — they are separate processes — so a
 * new chat opens next to the current one, which stays alive, prefilled with
 * a hand-over of what was said.
 */

export type SwitchPlan =
	| { readonly kind: "in-place"; readonly model: string }
	| { readonly kind: "new-chat"; readonly agent: AgentKind; readonly model: string; readonly prefill: string };

export function planModelSwitch(
	chat: { readonly agent: AgentKind; readonly running: boolean; readonly cards: readonly Card[]; readonly title: string } | null,
	choice: ModelChoice,
	model: string,
): SwitchPlan {
	if (chat && chat.agent === choice.agent) return { kind: "in-place", model };
	const prefill = chat ? buildHandover(chat.cards, agentName(chat.agent), chat.title) : "";
	return { kind: "new-chat", agent: choice.agent, model, prefill };
}
