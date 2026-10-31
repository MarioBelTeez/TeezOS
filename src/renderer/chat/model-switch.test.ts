import { describe, expect, test } from "vitest";
import { planModelSwitch } from "./model-switch.ts";
import { modelChoices } from "../../shared/models.ts";
import type { Card } from "./reduce.ts";

const [opus, sonnet, pro, flash] = modelChoices([
	{ id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
	{ id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
]);
const chat = (agent: "claude" | "agy", running = false, cards: readonly Card[] = []) => ({ agent, running, cards, title: "t" });

describe("planModelSwitch", () => {
	test("same agent switches in place, even mid-turn", () => {
		expect(planModelSwitch(chat("claude", true), sonnet!, "sonnet")).toEqual({ kind: "in-place", model: "sonnet" });
	});

	test("other agent opens a new chat and leaves the running one alone", () => {
		expect(planModelSwitch(chat("claude", true), pro!, "gemini-3.1-pro-high")).toEqual({
			kind: "new-chat",
			agent: "agy",
			model: "gemini-3.1-pro-high",
			prefill: "",
		});
	});

	test("the new chat is prefilled with a hand-over from the old one", () => {
		const cards: Card[] = [{ id: "c1", kind: "user", text: "fix the bug" }];
		const plan = planModelSwitch(chat("claude", false, cards), flash!, "gemini-3.8-flash-medium");
		expect(plan).toMatchObject({ kind: "new-chat", agent: "agy" });
		expect(plan.kind === "new-chat" ? plan.prefill : "").toMatch(/^Context from the Claude chat «t»:\n[\s\S]*fix the bug/);
	});

	test("going back from Antigravity names Antigravity as the source", () => {
		const cards: Card[] = [{ id: "c1", kind: "user", text: "hi" }];
		const plan = planModelSwitch(chat("agy", false, cards), opus!, "opus");
		expect(plan.kind === "new-chat" ? plan.prefill.split("\n")[0] : "").toBe("Context from the Antigravity chat «t»:");
	});

	test("no chat yet: new chat", () => {
		expect(planModelSwitch(null, opus!, "opus")).toMatchObject({ kind: "new-chat", agent: "claude", prefill: "" });
	});
});
