import { describe, expect, test } from "vitest";
import { PresenceTracker, buildActivity } from "./presence.ts";

const STARTED = 1_700_000_000_000;
const base = { mode: "on" as const, activeWorkspace: "TeezMind", version: "0.2.6", startedAt: STARTED };

describe("PresenceTracker", () => {
	test("a chat moves from idle to working to waiting and back", () => {
		const tracker = new PresenceTracker();
		expect(tracker.snapshot().state).toBe("idle");

		tracker.sent("c1", "claude", "teezai");
		expect(tracker.snapshot()).toMatchObject({ state: "working", agent: "claude", workspace: "teezai", running: 1 });

		tracker.waiting("c1");
		expect(tracker.snapshot().state).toBe("waiting");

		tracker.approved("c1");
		expect(tracker.snapshot().state).toBe("working");

		tracker.event("c1", { kind: "turn-end", sessionId: "s", ok: true, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: null });
		expect(tracker.snapshot().state).toBe("idle");
	});

	test("a cancelled or failed turn, or a closed chat, stops counting", () => {
		const tracker = new PresenceTracker();
		tracker.sent("a", "claude", "x");
		tracker.event("a", { kind: "turn-cancelled", sessionId: "s" } as never);
		tracker.sent("b", "agy", "y");
		tracker.event("b", { kind: "run-error", sessionId: "", reason: "boom", message: "boom" });
		tracker.sent("c", "claude", "z");
		tracker.closed("c");
		expect(tracker.snapshot().state).toBe("idle");
	});

	test("a waiting chat outranks a working one, and the count covers both", () => {
		const tracker = new PresenceTracker();
		tracker.sent("a", "claude", "teezai");
		tracker.sent("b", "agy", "clientsite");
		tracker.waiting("b");
		expect(tracker.snapshot()).toMatchObject({ state: "waiting", agent: "agy", workspace: "clientsite", running: 2 });
	});

	test("prune forgets chats that are no longer open", () => {
		const tracker = new PresenceTracker();
		tracker.sent("kept", "claude", "a");
		tracker.sent("gone", "claude", "b");
		expect(tracker.prune((id) => id === "kept")).toBe(true);
		expect(tracker.snapshot()).toMatchObject({ workspace: "a", running: 1 });
		expect(tracker.prune(() => true)).toBe(false);
	});

	test("a message sent mid-turn keeps the chat working until its own turn ends", () => {
		const tracker = new PresenceTracker();
		const end = { kind: "turn-end", sessionId: "s", ok: true, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: null } as const;
		tracker.sent("a", "claude", "x");
		tracker.sent("a", "claude", "x");
		tracker.event("a", end);
		expect(tracker.snapshot().state).toBe("working");
		tracker.event("a", end);
		expect(tracker.snapshot().state).toBe("idle");
	});

	test("an error before the chat was tracked does not leave it working", () => {
		const tracker = new PresenceTracker();
		expect(tracker.event("a", { kind: "run-error", sessionId: "", reason: "spawn", message: "spawn failed" })).toBe(false);
		expect(tracker.snapshot().state).toBe("idle");
	});

	test("approving a chat that is not running does nothing", () => {
		const tracker = new PresenceTracker();
		tracker.approved("ghost");
		tracker.waiting("ghost");
		expect(tracker.snapshot().state).toBe("idle");
	});

	test("reports whether a call changed anything", () => {
		const tracker = new PresenceTracker();
		expect(tracker.sent("a", "claude", "x")).toBe(true);
		expect(tracker.sent("a", "claude", "x")).toBe(false);
		expect(tracker.event("a", { kind: "text-delta", sessionId: "s", text: "hi" })).toBe(false);
	});
});

describe("buildActivity", () => {
	test("off means no activity at all", () => {
		expect(buildActivity({ state: "idle", running: 0 }, { ...base, mode: "off" })).toBeNull();
	});

	test("working names the agent and the workspace", () => {
		const activity = buildActivity({ state: "working", agent: "claude", workspace: "teezai", running: 1 }, base);
		expect(activity).toEqual({
			details: "Claude is working",
			state: "in teezai",
			timestamps: { start: STARTED },
			assets: { large_image: "teezai", large_text: "TeezOS 0.2.6" },
		});
	});

	test("several running chats say how many", () => {
		const activity = buildActivity({ state: "working", agent: "agy", workspace: "x", running: 3 }, base);
		expect(activity?.details).toBe("Antigravity is working · 3 chats");
	});

	test("waiting asks for the user", () => {
		const activity = buildActivity({ state: "waiting", agent: "claude", workspace: "x", running: 1 }, base);
		expect(activity?.details).toBe("Claude is waiting for approval");
	});

	test("idle shows the active workspace", () => {
		const activity = buildActivity({ state: "idle", running: 0 }, base);
		expect(activity).toMatchObject({ details: "Idle", state: "in TeezMind" });
	});

	test("hidden names never reach Discord", () => {
		const working = buildActivity({ state: "working", agent: "claude", workspace: "clientsite", running: 1 }, { ...base, mode: "private" });
		const idle = buildActivity({ state: "idle", running: 0 }, { ...base, mode: "private" });
		expect(JSON.stringify([working, idle])).not.toMatch(/clientsite|TeezMind/);
		expect(working?.state).toBeUndefined();
	});

	test("no active workspace leaves the second line out", () => {
		const activity = buildActivity({ state: "idle", running: 0 }, { ...base, activeWorkspace: null });
		expect(activity?.state).toBeUndefined();
	});

	const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
	const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

	test("names are cleaned and fit Discord's limits", () => {
		const long = `a${RIGHT_TO_LEFT_OVERRIDE}${"b".repeat(300)}`;
		const activity = buildActivity({ state: "working", agent: "claude", workspace: long, running: 1 }, base);
		expect(activity?.state?.length).toBeLessThanOrEqual(128);
		expect(activity?.state).not.toContain(RIGHT_TO_LEFT_OVERRIDE);
	});

	test("a one-letter name still makes a valid field; an invisible one is left out", () => {
		const activity = buildActivity({ state: "working", agent: "claude", workspace: "x", running: 1 }, base);
		expect(activity?.state).toBe("in x");
		const bare = buildActivity({ state: "idle", running: 0 }, { ...base, activeWorkspace: ZERO_WIDTH_SPACE });
		expect(bare?.state).toBeUndefined();
	});
});
