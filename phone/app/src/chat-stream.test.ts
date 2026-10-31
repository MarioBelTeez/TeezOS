import { describe, expect, test } from "vitest";
import type { Card } from "../../../src/renderer/chat/reduce.ts";
import { foldEvent, noticeLabel, parseChatEvent, reconnectDelay, settles, viewFromSnapshot } from "./chat-stream.ts";

const cards: Card[] = [
	{ id: "c1", kind: "user", text: "what is on the NAS?" },
	{ id: "c2", kind: "assistant", text: "Your NAS holds" },
];
const snapshot = { id: "x", title: "NAS", engine: "agy" as const, effort: "medium", conversationId: "conv", cards, createdAt: 1, updatedAt: 2 };

describe("viewFromSnapshot", () => {
	test("carries on card numbering after the highest id", () => {
		const view = viewFromSnapshot({ ...snapshot, running: false });
		expect(view.cards).toEqual(cards);
		expect(view.nextId).toBe(3);
		expect(view.running).toBe(false);
		expect(view.streamingId).toBeNull();
	});

	test("a running chat keeps streaming into its last reply", () => {
		let view = viewFromSnapshot({ ...snapshot, running: true });
		view = foldEvent(view, { kind: "text-delta", sessionId: "conv", text: " three backups." });
		expect(view.cards).toHaveLength(2);
		expect(view.cards[1]).toEqual({ id: "c2", kind: "assistant", text: "Your NAS holds three backups." });
		view = foldEvent(view, { kind: "turn-end", sessionId: "conv", ok: true, text: "", durationMs: 900, numTurns: 1, costUsd: 0, context: null });
		expect(view.running).toBe(false);
	});
});

describe("foldEvent", () => {
	test("folds the service's notices in as notice cards", () => {
		const view = foldEvent(viewFromSnapshot({ ...snapshot, running: false }), {
			kind: "notice",
			sessionId: "conv",
			text: "Saved to the vault: thinking/phone-2026-10-18-0912-router.md",
		});
		expect(view.cards.at(-1)).toEqual({ id: "c3", kind: "notice", text: "Saved to the vault: thinking/phone-2026-10-18-0912-router.md" });
	});

	test("a new reply after a finished one starts its own card", () => {
		let view = viewFromSnapshot({ ...snapshot, running: false });
		view = foldEvent(view, { kind: "text-delta", sessionId: "conv", text: "Next" });
		expect(view.cards).toHaveLength(3);
		expect(view.cards[2]).toEqual({ id: "c3", kind: "assistant", text: "Next" });
	});
});

describe("parseChatEvent", () => {
	test("accepts an event object and refuses anything else", () => {
		expect(parseChatEvent('{"kind":"text-delta","sessionId":"s","text":"hi"}')).toEqual({ kind: "text-delta", sessionId: "s", text: "hi" });
		expect(parseChatEvent("not json")).toBeNull();
		expect(parseChatEvent("[1,2]")).toBeNull();
		expect(parseChatEvent('{"text":"no kind"}')).toBeNull();
	});
});

describe("settles", () => {
	test("the end of a turn and a notice call for a fresh copy of the chat", () => {
		expect(settles({ kind: "turn-cancelled", sessionId: "s", durationMs: 1 })).toBe(true);
		expect(settles({ kind: "run-error", sessionId: "s", reason: "x", message: "y" })).toBe(true);
		expect(settles({ kind: "notice", sessionId: "s", text: "t" })).toBe(true);
		expect(settles({ kind: "text-delta", sessionId: "s", text: "t" })).toBe(false);
	});
});

describe("noticeLabel", () => {
	test("names a saved capture by its title", () => {
		expect(noticeLabel("Saved to the vault: thinking/phone-2026-10-18-0912-router-password.md")).toBe("Saved to brain: router password");
	});

	test("says when a capture is saved but not synced yet", () => {
		expect(noticeLabel("Saved to the vault: thinking/phone-2026-10-18-0912-router.md (saved, not synced yet)")).toBe(
			"Saved to brain: router · saved, not synced yet",
		);
	});

	test("leaves any other notice as it is", () => {
		expect(noticeLabel("Context compacted · 150k tokens before")).toBe("Context compacted · 150k tokens before");
	});
});

describe("reconnectDelay", () => {
	test("backs off 2 s, 5 s, 15 s, then every 30 s", () => {
		expect([0, 1, 2, 3, 4, 10].map(reconnectDelay)).toEqual([2000, 5000, 15_000, 30_000, 30_000, 30_000]);
	});
});
