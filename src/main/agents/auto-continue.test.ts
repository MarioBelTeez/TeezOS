import { describe, expect, test } from "vitest";
import type { UiEvent } from "../claude/events.ts";
import {
	AutoContinue,
	MAX_TRIES,
	MAX_WAIT_MS,
	RESUME_GRACE_MS,
	RETRY_MS,
	detectLimitHit,
	parseResetTime,
	scheduleDelay,
	type PauseChange,
} from "./auto-continue.ts";

const rejected = (resetsAt: number, window = "five_hour"): UiEvent => ({ kind: "rate-limit", sessionId: "s", status: "rejected", window, resetsAt });
const turnEnd = (text: string): UiEvent => ({ kind: "turn-end", sessionId: "s", ok: true, text, durationMs: 1, numTurns: 1, costUsd: 0, context: null });
const runError = (message: string): UiEvent => ({ kind: "run-error", sessionId: "s", reason: "error_during_execution", message });
const HIT = "You've hit your session limit";

const NOW = Date.parse("2026-10-15T17:00:00Z"); // 19:00 in Rome (UTC+2, summer time)

describe("parseResetTime", () => {
	test("5am in Rome is the next morning", () => {
		expect(parseResetTime("You've hit your session limit · resets 5am (Europe/Rome)", NOW)).toBe(Date.parse("2026-10-16T03:00:00Z"));
	});

	test("2pm in Rome has already passed today, so it is tomorrow", () => {
		expect(parseResetTime("resets 2pm (Europe/Rome)", NOW)).toBe(Date.parse("2026-10-16T12:00:00Z"));
	});

	test("11:40pm in Rome is later today", () => {
		expect(parseResetTime("resets 11:40pm (Europe/Rome)", NOW)).toBe(Date.parse("2026-10-15T21:40:00Z"));
	});

	test("7:30am in Rome", () => {
		expect(parseResetTime("resets 7:30am (Europe/Rome)", NOW)).toBe(Date.parse("2026-10-16T05:30:00Z"));
	});

	test("a zone in winter time uses its own offset", () => {
		expect(parseResetTime("resets 5am (America/New_York)", Date.parse("2026-01-10T12:00:00Z"))).toBe(Date.parse("2026-01-11T10:00:00Z"));
	});

	test("12am is midnight and 12pm is noon", () => {
		expect(parseResetTime("resets 12am (UTC)", Date.parse("2026-01-10T12:00:00Z"))).toBe(Date.parse("2026-01-11T00:00:00Z"));
		expect(parseResetTime("resets 12pm (UTC)", Date.parse("2026-01-10T06:00:00Z"))).toBe(Date.parse("2026-01-10T12:00:00Z"));
	});

	test("an unknown zone reads as local time", () => {
		const at = parseResetTime("resets 5am (Mars/Olympus)", NOW);
		expect(at).not.toBeNull();
		expect(new Date(at ?? 0).getHours()).toBe(5);
		expect(new Date(at ?? 0).getMinutes()).toBe(0);
	});

	test("no time in the message is null", () => {
		expect(parseResetTime("You've hit your limit", NOW)).toBeNull();
	});
});

describe("detectLimitHit", () => {
	test("a rejected rate-limit event carries its reset time in milliseconds", () => {
		expect(detectLimitHit(rejected(1_789_573_200))).toEqual({ resetsAt: 1_789_573_200_000 });
	});

	test("a rejected event with no reset time is a hit with an unknown reset", () => {
		expect(detectLimitHit(rejected(0))).toEqual({ resetsAt: null });
	});

	test("allowed and warning events are not hits", () => {
		expect(detectLimitHit({ kind: "rate-limit", sessionId: "s", status: "allowed", window: "five_hour", resetsAt: 1 })).toBeNull();
		expect(detectLimitHit({ kind: "rate-limit", sessionId: "s", status: "allowed_warning", window: "five_hour", resetsAt: 1 })).toBeNull();
	});

	test("an overage rejection is not the plan limit", () => {
		expect(detectLimitHit(rejected(5, "overage"))).toBeNull();
	});

	test("the CLI's own limit message, as a final answer or an error, is a hit", () => {
		expect(detectLimitHit(turnEnd(HIT))).toEqual({ resetsAt: null });
		expect(detectLimitHit(turnEnd("You’ve hit your usage limit"))).toEqual({ resetsAt: null });
		expect(detectLimitHit(turnEnd("You've hit your session limit · resets 5am (Europe/Rome)"), NOW)?.resetsAt).toBe(Date.parse("2026-10-16T03:00:00Z"));
		expect(detectLimitHit(runError("Claude AI usage limit reached|1789573200"))).toEqual({ resetsAt: null });
		expect(detectLimitHit(runError("5-hour limit reached"))).toEqual({ resetsAt: null });
	});

	test("an ordinary answer or error that merely mentions limits is not", () => {
		expect(detectLimitHit(turnEnd("I added a rate limit to the API route."))).toBeNull();
		expect(detectLimitHit(runError("Process exited with code 1"))).toBeNull();
		expect(detectLimitHit({ kind: "text-delta", sessionId: "s", text: HIT })).toBeNull();
	});
});

describe("scheduleDelay", () => {
	const now = 1_000_000;

	test("waits for the reset plus 30 seconds", () => {
		expect(scheduleDelay(now + 600_000, now)).toBe(600_000 + RESUME_GRACE_MS);
	});

	test("never longer than 6 hours", () => {
		expect(scheduleDelay(now + 20 * 3_600_000, now)).toBe(MAX_WAIT_MS);
	});

	test("a reset already past never goes negative", () => {
		expect(scheduleDelay(now - 10 * 60_000, now)).toBe(0);
	});

	test("without a reset time, retries every 15 minutes", () => {
		expect(scheduleDelay(null, now)).toBe(RETRY_MS);
	});
});

type Timer = { fn: () => void; ms: number };

function harness() {
	const timers = new Map<number, Timer>();
	const sent: string[] = [];
	const changes: PauseChange[] = [];
	const clock = { now: 1_000_000 };
	const enabled = { value: true };
	let next = 1;
	const auto = new AutoContinue({
		now: () => clock.now,
		setTimer: (fn, ms) => {
			const id = next++;
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimer: (id) => void timers.delete(id as number),
		send: (_chatId, text) => {
			sent.push(text);
			return true;
		},
		enabled: () => enabled.value,
		onChange: (change) => void changes.push(change),
	});
	const soon = (seconds: number): number => Math.floor(clock.now / 1000) + seconds;
	const fire = (): void => {
		const first = [...timers.entries()][0];
		if (!first) throw new Error("no timer");
		timers.delete(first[0]);
		first[1].fn();
	};
	const onlyDelay = (): number | undefined => [...timers.values()][0]?.ms;
	return { auto, sent, changes, timers, enabled, soon, fire, onlyDelay };
}

describe("AutoContinue", () => {
	test("a limit hit schedules one timer and reports when the chat will resume", () => {
		const h = harness();
		h.auto.event("a", rejected(h.soon(3600)));
		expect(h.timers.size).toBe(1);
		expect(h.changes.at(-1)).toMatchObject({ kind: "waiting", chatId: "a", estimated: false });
	});

	test("the turn-end that follows the rejected event keeps the one timer and its time", () => {
		const h = harness();
		h.auto.event("a", rejected(h.soon(3600)));
		h.auto.event("a", turnEnd(HIT));
		expect(h.timers.size).toBe(1);
		expect(h.onlyDelay()).toBeGreaterThan(3_000_000);
	});

	test("when the time comes it sends continue and says so", () => {
		const h = harness();
		h.auto.event("a", rejected(h.soon(60)));
		h.auto.event("a", turnEnd(HIT));
		h.fire();
		expect(h.sent).toEqual(["continue"]);
		expect(h.changes.at(-1)).toEqual({ kind: "resumed", chatId: "a" });
		expect(h.timers.size).toBe(0);
	});

	test("a message from the user takes over: the schedule is dropped", () => {
		const h = harness();
		h.auto.event("a", rejected(h.soon(60)));
		h.auto.userSent("a");
		expect(h.timers.size).toBe(0);
		expect(h.changes.at(-1)).toEqual({ kind: "cleared", chatId: "a" });
	});

	test("cancel clears the schedule and nothing is sent", () => {
		const h = harness();
		h.auto.event("a", rejected(h.soon(60)));
		h.auto.cancel("a");
		expect(h.timers.size).toBe(0);
		expect(h.sent).toEqual([]);
		expect(h.changes.at(-1)).toEqual({ kind: "cleared", chatId: "a" });
	});

	test("closing a chat clears its timer", () => {
		const h = harness();
		h.auto.event("a", rejected(h.soon(60)));
		h.auto.close("a");
		expect(h.timers.size).toBe(0);
	});

	test("disposeAll clears every timer", () => {
		const h = harness();
		h.auto.event("a", rejected(h.soon(60)));
		h.auto.event("b", rejected(h.soon(90)));
		h.auto.disposeAll();
		expect(h.timers.size).toBe(0);
	});

	test("with the setting off nothing is scheduled", () => {
		const h = harness();
		h.enabled.value = false;
		h.auto.event("a", rejected(h.soon(60)));
		expect(h.timers.size).toBe(0);
	});

	test("turning the setting off while waiting cancels everything", () => {
		const h = harness();
		h.auto.event("a", rejected(h.soon(60)));
		h.enabled.value = false;
		h.auto.settingsChanged();
		expect(h.timers.size).toBe(0);
		expect(h.changes.at(-1)).toEqual({ kind: "cleared", chatId: "a" });
	});

	test("a hit with no reset time retries every 15 minutes, 24 times (6 hours)", () => {
		const h = harness();
		h.auto.event("a", turnEnd(HIT));
		for (let i = 0; i < MAX_TRIES; i += 1) {
			expect(h.timers.size).toBe(1);
			expect(h.onlyDelay()).toBe(RETRY_MS);
			h.fire();
			h.auto.event("a", turnEnd(HIT));
		}
		expect(h.sent).toHaveLength(MAX_TRIES);
		expect(h.timers.size).toBe(0);
		expect(h.changes.at(-1)).toEqual({ kind: "cleared", chatId: "a" });
	});

	test("a turn that finishes normally ends the cycle and the count starts over", () => {
		const h = harness();
		h.auto.event("a", turnEnd(HIT));
		h.fire();
		h.auto.event("a", turnEnd("All done."));
		for (let i = 0; i < MAX_TRIES; i += 1) {
			h.auto.event("a", turnEnd(HIT));
			expect(h.timers.size).toBe(1);
			h.fire();
		}
		expect(h.sent).toHaveLength(MAX_TRIES + 1);
	});

	test("a chat still busy when the timer fires is checked again a minute later, nothing sent", () => {
		const h = harness();
		h.auto.event("a", turnEnd(HIT));
		h.auto.markBusy("a");
		h.fire();
		expect(h.sent).toEqual([]);
		expect(h.onlyDelay()).toBe(60_000);
	});

	test("the fallback covers a full window", () => {
		expect(MAX_TRIES * RETRY_MS).toBe(MAX_WAIT_MS);
	});

	test("a limit message with its own time schedules for that time", () => {
		const h = harness();
		h.auto.event("a", turnEnd("You've hit your session limit · resets 11:40pm (UTC)"));
		expect(h.onlyDelay()).toBeGreaterThan(0);
		expect(h.onlyDelay()).not.toBe(RETRY_MS);
		expect(h.changes.at(-1)).toMatchObject({ kind: "waiting", estimated: false });
	});

	test("a continue that hits the limit again at once waits 15 minutes, not zero", () => {
		const h = harness();
		h.auto.event("a", rejected(h.soon(-600)));
		expect(h.onlyDelay()).toBe(0);
		h.fire();
		h.auto.event("a", turnEnd(HIT));
		expect(h.onlyDelay()).toBe(RETRY_MS);
	});

	test("a stale past reset in a fresh event after a continue also waits 15 minutes", () => {
		const h = harness();
		h.auto.event("a", rejected(h.soon(-600)));
		h.fire();
		h.auto.event("a", rejected(h.soon(-600)));
		expect(h.onlyDelay()).toBe(RETRY_MS);
		expect(h.changes.at(-1)).toMatchObject({ kind: "waiting", estimated: true });
	});

	test("any turn under way defers the timer, however it started", () => {
		const h = harness();
		h.auto.event("a", turnEnd(HIT));
		h.auto.event("a", { kind: "text-delta", sessionId: "s", text: "hi" });
		h.fire();
		expect(h.sent).toEqual([]);
		expect(h.onlyDelay()).toBe(60_000);
	});

	test("a Stop from the user drops the schedule", () => {
		const h = harness();
		h.auto.event("a", turnEnd(HIT));
		h.auto.event("a", { kind: "turn-cancelled", sessionId: "s", durationMs: 1 });
		expect(h.timers.size).toBe(0);
	});
});
