import type { AgentKind, AgentSettings } from "../main/settings/store.ts";

/** What a new chat with `agent` starts on when the caller names nothing: the defaults from Settings → Chat. */
export function agentDefaults(
	agent: AgentKind,
	settings: AgentSettings,
): { readonly model: string; readonly permission: string; readonly effort: string } {
	switch (agent) {
		case "claude":
			return { model: settings.claudeModel, permission: settings.claudePermission, effort: settings.claudeEffort };
		case "codex":
			return { model: settings.codexModel, permission: settings.codexPermission, effort: settings.codexEffort };
		case "agy":
			return { model: settings.agyModel, permission: settings.agyPermission, effort: settings.agyEffort };
	}
}
