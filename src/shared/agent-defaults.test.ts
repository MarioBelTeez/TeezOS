import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS } from "../main/settings/store.ts";
import { agentDefaults } from "./agent-defaults.ts";

const agent = {
	...DEFAULT_SETTINGS.agent,
	claudeModel: "opus",
	claudePermission: "auto" as const,
	claudeEffort: "high" as const,
	agyModel: "gemini-3.8-flash-medium",
	agyPermission: "accept-edits" as const,
	agyEffort: "medium" as const,
	codexModel: "gpt-5.5",
	codexPermission: "auto-edit" as const,
	codexEffort: "low" as const,
};

describe("agentDefaults", () => {
	test("each agent gets its own model, mode and effort", () => {
		expect(agentDefaults("claude", agent)).toEqual({ model: "opus", permission: "auto", effort: "high" });
		expect(agentDefaults("agy", agent)).toEqual({ model: "gemini-3.8-flash-medium", permission: "accept-edits", effort: "medium" });
		expect(agentDefaults("codex", agent)).toEqual({ model: "gpt-5.5", permission: "auto-edit", effort: "low" });
	});
});
