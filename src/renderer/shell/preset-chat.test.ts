import { describe, expect, test } from "vitest";
import type { AgentSettings } from "../../main/settings/store.ts";
import { agentPatchOf, presetChatOf } from "./preset-chat.ts";

const agent: AgentSettings = {
	defaultAgent: "claude",
	claudeModel: "sonnet",
	claudePermission: "auto",
	claudeEffort: "high",
	agyModel: "gemini-3.1-pro-high",
	agyPermission: "accept-edits",
	agyEffort: "medium",
	codexModel: "gpt-5.5",
	codexPermission: "auto-edit",
	codexEffort: "low",
	notify: true,
	presence: "on",
};

describe("presetChatOf", () => {
	test("the default agent with its model and mode", () => {
		expect(presetChatOf(agent)).toEqual({ agent: "claude", model: "sonnet", permission: "auto", effort: "high" });
		expect(presetChatOf({ ...agent, defaultAgent: "agy" })).toEqual({ agent: "agy", model: "gemini-3.1-pro-high", permission: "accept-edits", effort: "medium" });
	});
});

describe("agentPatchOf", () => {
	test("sets the default agent, its model and its mode", () => {
		expect(agentPatchOf({ agent: "claude", model: "opus", permission: "plan" })).toEqual({ defaultAgent: "claude", claudeModel: "opus", claudePermission: "plan" });
		expect(agentPatchOf({ agent: "agy", model: "gemini-3.8-flash-low", permission: "full-auto" })).toEqual({
			defaultAgent: "agy",
			agyModel: "gemini-3.8-flash-low",
			agyPermission: "full-auto",
			agyEffort: "low",
		});
	});
	test("a mode the agent does not have is left as it is", () => {
		expect(agentPatchOf({ agent: "claude", model: "opus", permission: "full-auto" })).toEqual({ defaultAgent: "claude", claudeModel: "opus" });
		expect(agentPatchOf({ agent: "agy", model: "", permission: "bypassPermissions" })).toEqual({ defaultAgent: "agy", agyModel: "" });
	});
	test("a saved effort comes back; one saved before efforts existed, or not the agent's, is left alone", () => {
		expect(agentPatchOf({ agent: "claude", model: "opus", permission: "plan", effort: "max" })).toMatchObject({ claudeEffort: "max" });
		expect(agentPatchOf({ agent: "claude", model: "opus", permission: "plan", effort: "" })).toMatchObject({ claudeEffort: "" });
		expect(agentPatchOf({ agent: "agy", model: "", permission: "plan", effort: "low" })).toMatchObject({ agyEffort: "low" });
		expect(agentPatchOf({ agent: "claude", model: "opus", permission: "plan" })).not.toHaveProperty("claudeEffort");
		expect(agentPatchOf({ agent: "agy", model: "", permission: "plan", effort: "max" })).not.toHaveProperty("agyEffort");
	});
	test("an Antigravity preset without an effort takes it from its model's level", () => {
		expect(agentPatchOf({ agent: "agy", model: "gemini-3.8-flash-high", permission: "plan" })).toMatchObject({ agyEffort: "high" });
		expect(agentPatchOf({ agent: "agy", model: "", permission: "plan" })).not.toHaveProperty("agyEffort");
	});
});

describe("Codex presets", () => {
	test("a Codex default agent saves Codex's model, mode and effort", () => {
		expect(presetChatOf({ ...agent, defaultAgent: "codex" })).toEqual({ agent: "codex", model: "gpt-5.5", permission: "auto-edit", effort: "low" });
	});
	test("applying a Codex preset sets the default agent and Codex's fields; an unknown mode or effort is skipped", () => {
		expect(agentPatchOf({ agent: "codex", model: "gpt-6.1-sol", permission: "full-access", effort: "high" })).toEqual({
			defaultAgent: "codex",
			codexModel: "gpt-6.1-sol",
			codexPermission: "full-access",
			codexEffort: "high",
		});
		expect(agentPatchOf({ agent: "codex", model: "gpt-5.5", permission: "plan", effort: "ultra" })).toEqual({ defaultAgent: "codex", codexModel: "gpt-5.5" });
	});
});
