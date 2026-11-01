import type { AgentSettings } from "../../main/settings/store.ts";
import type { Preset } from "../../shared/presets.ts";
import { AGY_PERMISSIONS, CLAUDE_PERMISSIONS, CODEX_PERMISSIONS } from "../chat/agent-options.ts";
import { agentDefaults } from "../../shared/agent-defaults.ts";
import { isEffort } from "../../shared/effort.ts";

/**
 * A preset's chat defaults: which agent new chats use, on which model, in
 * which mode and at which effort. Pure, so saving and applying are tested without a window.
 */

export type PresetChat = NonNullable<Preset["chat"]>;

export function presetChatOf(agent: AgentSettings): PresetChat {
	return { agent: agent.defaultAgent, ...agentDefaults(agent.defaultAgent, agent) };
}

/**
 * The settings patch that makes those the defaults. A mode or effort the agent
 * does not have is skipped, not guessed; so is an effort the preset never saved.
 */
export function agentPatchOf(chat: PresetChat): Partial<AgentSettings> {
	const effortKnown = isEffort(chat.agent, chat.effort);
	if (chat.agent === "claude") {
		const known = CLAUDE_PERMISSIONS.some((p) => p.id === chat.permission);
		return {
			defaultAgent: "claude",
			claudeModel: chat.model,
			...(known ? { claudePermission: chat.permission as AgentSettings["claudePermission"] } : {}),
			...(effortKnown ? { claudeEffort: chat.effort as AgentSettings["claudeEffort"] } : {}),
		};
	}
	if (chat.agent === "codex") {
		return {
			defaultAgent: "codex",
			codexModel: chat.model,
			...(CODEX_PERMISSIONS.some((p) => p.id === chat.permission) ? { codexPermission: chat.permission as AgentSettings["codexPermission"] } : {}),
			...(effortKnown ? { codexEffort: chat.effort as AgentSettings["codexEffort"] } : {}),
		};
	}
	const known = AGY_PERMISSIONS.some((p) => p.id === chat.permission);
	// A preset from before 0.3.8 has no effort; its Gemini model's level suffix says what it was.
	const agyEffort = effortKnown ? chat.effort : /-(low|medium|high)$/.exec(chat.model)?.[1];
	return {
		defaultAgent: "agy",
		agyModel: chat.model,
		...(known ? { agyPermission: chat.permission as AgentSettings["agyPermission"] } : {}),
		...(agyEffort ? { agyEffort: agyEffort as AgentSettings["agyEffort"] } : {}),
	};
}
