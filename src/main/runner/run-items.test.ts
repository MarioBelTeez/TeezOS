import { describe, expect, test } from "vitest";
import { runItems } from "./run-items.ts";
import type { RunEvent } from "../../../runner/src/types.ts";

const events = (data: unknown[]): RunEvent[] => data.map((d, seq) => ({ seq, at: seq, data: d }));

describe("runItems", () => {
	test("an Antigravity run reads like a chat: prompt, runner note, reply, end", () => {
		const items = runItems(
			{ prompt: "Summarise" },
			events([
				{ type: "runner", text: "antigravity read-only in /home/agent/work/TeezMind" },
				{ event: "init", conversation_id: "c1", init: { cwd: "/w", tools: [], permission_mode: "request-review" } },
				{ event: "step_update", step_update: { conversation_id: "c1", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "Three notes changed." } },
				{ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "Three notes changed.", duration_seconds: 2, num_turns: 1 } },
			]),
		);
		expect(items.map((i) => i.kind)).toEqual(["user", "notice", "text-delta", "turn-end"]);
		expect(items[2]).toMatchObject({ text: "Three notes changed." });
	});

	test("refusals are explained by the runner's note, not by the chat's 'switch mode' advice", () => {
		const items = runItems(
			null,
			events([
				{ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "", denied_actions: [{ action: "command" }] } },
				{ type: "runner", text: "Antigravity was refused: command." },
			]),
		);
		expect(items.some((i) => i.kind === "run-error")).toBe(false);
		expect(items.at(-1)).toEqual({ kind: "notice", text: "Antigravity was refused: command." });
	});

	test("a Claude run still converts as before", () => {
		const items = runItems(
			null,
			events([
				{ type: "system", subtype: "init", session_id: "s1", model: "opus", tools: [], cwd: "/w", permissionMode: "default", slash_commands: [] },
				{ type: "result", subtype: "success", result: "Done.", total_cost_usd: 0.01, is_error: false, session_id: "s1", num_turns: 1, duration_ms: 5 },
			]),
		);
		expect(items.map((i) => i.kind)).toContain("turn-end");
	});
});
