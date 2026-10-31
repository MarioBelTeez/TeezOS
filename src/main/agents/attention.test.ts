import { describe, expect, test } from "vitest";
import { attentionForApproval, attentionForEvent } from "./attention.ts";

const context = { agent: "claude" as const, workspace: "teezai" };

describe("attentionForEvent", () => {
	test("a finished turn says where, and the first line of the answer", () => {
		const note = attentionForEvent(
			{ kind: "turn-end", sessionId: "s", ok: true, text: "\n## Done\nAll 231 tests pass.", durationMs: 1, numTurns: 1, costUsd: 0, context: null },
			context,
		);
		expect(note).toEqual({ title: "Claude finished · teezai", body: "Done" });
	});

	test("an empty answer still reads as finished", () => {
		const note = attentionForEvent({ kind: "turn-end", sessionId: "s", ok: true, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: null }, context);
		expect(note?.body).toBe("Done.");
	});

	test("a failure is worth a look, a refused image or a closed chat is not", () => {
		expect(attentionForEvent({ kind: "run-error", sessionId: "s", reason: "sdk-error", message: "Process exited" }, { agent: "agy", workspace: "vault" })).toEqual({
			title: "Antigravity stopped · vault",
			body: "Process exited",
		});
		expect(attentionForEvent({ kind: "run-error", sessionId: "", reason: "bad-image", message: "x" }, context)).toBeNull();
		expect(attentionForEvent({ kind: "run-error", sessionId: "", reason: "chat-closed", message: "x" }, context)).toBeNull();
	});

	test("streaming, tools and a cancel the user pressed are not", () => {
		expect(attentionForEvent({ kind: "text-delta", sessionId: "s", text: "hi" }, context)).toBeNull();
		expect(attentionForEvent({ kind: "turn-cancelled", sessionId: "s", durationMs: 1 }, context)).toBeNull();
	});

	test("bodies are one short line", () => {
		const note = attentionForEvent(
			{ kind: "turn-end", sessionId: "s", ok: true, text: `${"word ".repeat(100)}\nsecond line`, durationMs: 1, numTurns: 1, costUsd: 0, context: null },
			context,
		);
		expect(note?.body.length).toBeLessThanOrEqual(160);
		expect(note?.body).not.toContain("\n");
	});
});

describe("attentionForApproval", () => {
	test("names the tool and what it would touch", () => {
		expect(attentionForApproval({ id: "a", toolName: "Bash", input: { command: "npm run release", description: "publish" } }, context)).toEqual({
			title: "Claude is waiting for you · teezai",
			body: "Bash: npm run release",
		});
		expect(attentionForApproval({ id: "a", toolName: "Edit", input: { file_path: "src/a.ts", old_string: "x" } }, context).body).toBe("Edit: src/a.ts");
	});

	test("zero-width, separator and C1 characters are removed too, also from the workspace name", () => {
		const note = attentionForApproval(
			{ id: "a", toolName: "Bash", input: { command: "rm\u200b\u200d\u2028\u061c\ufeff\u0085\u2060 -rf x" } },
			{ agent: "claude", workspace: "team\u202eai" },
		);
		expect(note).toEqual({ title: "Claude is waiting for you · teamai", body: "Bash: rm -rf x" });
	});

	test("control and bidi characters do not reach the notification", () => {
		const body = attentionForApproval({ id: "a", toolName: "Bash", input: { command: "ls\u202e\u0007 -la" } }, context).body;
		expect(body).toBe("Bash: ls -la");
	});
});
