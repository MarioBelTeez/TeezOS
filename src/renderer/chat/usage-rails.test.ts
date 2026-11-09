import { describe, expect, test } from "vitest";
import { RAIL_MAX_WIDTH, RAIL_MIN_SPACE, agyLimitRows, barTone, contextSummary, formatPct, formatResetsIn, formatTokens, limitRows, railLayout, weeklyShare, weeklyWarning } from "./usage-rails.ts";
import type { AgyUsage, ClaudeUsage } from "../../shared/usage.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-14T18:00:00Z");

describe("formatResetsIn", () => {
	test("hours and minutes", () => {
		expect(formatResetsIn(NOW + 2 * HOUR + 14 * MIN, NOW)).toBe("resets in 2h 14m");
	});
	test("whole hours drop the minutes", () => {
		expect(formatResetsIn(NOW + 3 * HOUR, NOW)).toBe("resets in 3h");
	});
	test("under an hour is minutes, rounded up so it never says 0m", () => {
		expect(formatResetsIn(NOW + 14 * MIN, NOW)).toBe("resets in 14m");
		expect(formatResetsIn(NOW + 13 * MIN + 1, NOW)).toBe("resets in 14m");
		expect(formatResetsIn(NOW + 1, NOW)).toBe("resets in 1m");
	});
	test("a day or more is days and hours", () => {
		expect(formatResetsIn(NOW + 3 * DAY + 4 * HOUR + 20 * MIN, NOW)).toBe("resets in 3d 4h");
		expect(formatResetsIn(NOW + 2 * DAY, NOW)).toBe("resets in 2d");
	});
	test("rounding up across a boundary carries over", () => {
		expect(formatResetsIn(NOW + 59 * MIN + 30_000, NOW)).toBe("resets in 1h");
	});
	test("already past is 'resets now'; unknown is null", () => {
		expect(formatResetsIn(NOW, NOW)).toBe("resets now");
		expect(formatResetsIn(NOW - HOUR, NOW)).toBe("resets now");
		expect(formatResetsIn(null, NOW)).toBeNull();
	});
});

describe("formatPct", () => {
	test("whole percent", () => {
		expect(formatPct(42.4)).toBe("42%");
		expect(formatPct(99.6)).toBe("100%");
		expect(formatPct(0)).toBe("0%");
	});
});

describe("barTone", () => {
	test("red below 75, amber from 75, red-hot from 90", () => {
		expect(barTone(0)).toBe("normal");
		expect(barTone(74.9)).toBe("normal");
		expect(barTone(75)).toBe("warn");
		expect(barTone(89.9)).toBe("warn");
		expect(barTone(90)).toBe("hot");
		expect(barTone(100)).toBe("hot");
	});
});

describe("railLayout", () => {
	test("hidden unless each side has at least 180 px free", () => {
		expect(RAIL_MIN_SPACE).toBe(180);
		expect(railLayout(1180 + 2 * 179, 1180)).toBeNull();
		expect(railLayout(1180 + 2 * 180, 1180)).not.toBeNull();
	});
	test("a composer as wide as its row (narrow window) leaves no rails", () => {
		expect(railLayout(900, 900)).toBeNull();
		expect(railLayout(0, 0)).toBeNull();
	});
	test("the rail fills the free side less its gap to the composer, up to a cap", () => {
		const tight = railLayout(1180 + 2 * 180, 1180);
		expect(tight).toEqual({ width: 180 - (tight?.gap ?? 0), gap: tight?.gap });
		expect(tight!.width).toBeGreaterThan(0);
		expect(railLayout(2400, 1180)?.width).toBe(RAIL_MAX_WIDTH);
	});
});

describe("weeklyShare", () => {
	const usage = (over: Partial<ClaudeUsage> = {}): ClaudeUsage => ({
		fiveHour: null,
		weekly: { pct: 20, resetsAt: null },
		weeklyOpus: { pct: 30, resetsAt: null },
		weeklySonnet: { pct: 5, resetsAt: null },
		models: [],
		...over,
	});

	test("Opus chats (and the default, which is Opus) get the Opus share", () => {
		expect(weeklyShare(usage(), "claude", "opus")).toEqual({ label: "Opus", window: { pct: 30, resetsAt: null } });
		expect(weeklyShare(usage(), "claude", "")).toEqual({ label: "Opus", window: { pct: 30, resetsAt: null } });
		expect(weeklyShare(usage(), "claude", "claude-opus-4-20250514")?.label).toBe("Opus");
	});
	test("Sonnet chats get the Sonnet share", () => {
		expect(weeklyShare(usage(), "claude", "sonnet")).toEqual({ label: "Sonnet", window: { pct: 5, resetsAt: null } });
	});
	test("no share when that window is absent, unless a per-model row names the family", () => {
		expect(weeklyShare(usage({ weeklySonnet: null }), "claude", "sonnet")).toBeNull();
		expect(weeklyShare(usage({ weeklySonnet: null, models: [{ name: "Sonnet", pct: 9, resetsAt: null }] }), "claude", "sonnet")).toEqual({
			label: "Sonnet",
			window: { pct: 9, resetsAt: null },
		});
	});
	test("an unknown model or a Gemini chat shows no share", () => {
		expect(weeklyShare(usage(), "claude", "haiku")).toBeNull();
		expect(weeklyShare(usage(), "agy", "gemini-3.8-flash-high")).toBeNull();
	});
});

describe("limitRows", () => {
	const base: ClaudeUsage = {
		fiveHour: { pct: 10, resetsAt: null },
		weekly: { pct: 20, resetsAt: null },
		weeklyOpus: { pct: 30, resetsAt: null },
		weeklySonnet: null,
		models: [],
	};
	test("only the 5-hour bar; the week appears as a warning instead", () => {
		expect(limitRows(base).map((r) => r.label)).toEqual(["5-hour"]);
	});
	test("no bar without a 5-hour window", () => {
		expect(limitRows({ ...base, fiveHour: null })).toEqual([]);
	});
});

describe("weeklyWarning", () => {
	const usage = (over: Partial<ClaudeUsage> = {}): ClaudeUsage => ({
		fiveHour: { pct: 10, resetsAt: null },
		weekly: { pct: 20, resetsAt: null },
		weeklyOpus: { pct: 30, resetsAt: null },
		weeklySonnet: { pct: 5, resetsAt: null },
		models: [],
		...over,
	});
	test("silent below 75 percent", () => {
		expect(weeklyWarning(usage({ weekly: { pct: 74.4, resetsAt: null } }), "claude", "opus")).toBeNull();
	});
	test("warns from 75 percent on the overall week", () => {
		expect(weeklyWarning(usage({ weekly: { pct: 75, resetsAt: null } }), "claude", "sonnet")).toBe("Weekly limit at 75%");
	});
	test("takes the higher of the week and this model's share", () => {
		expect(weeklyWarning(usage({ weekly: { pct: 40, resetsAt: null }, weeklyOpus: { pct: 81.2, resetsAt: null } }), "claude", "opus")).toBe("Weekly limit at 81%");
	});
	test("another model's share does not count", () => {
		expect(weeklyWarning(usage({ weeklyOpus: { pct: 95, resetsAt: null } }), "claude", "sonnet")).toBeNull();
	});
	test("a Gemini chat still sees the overall week", () => {
		expect(weeklyWarning(usage({ weekly: { pct: 90, resetsAt: null } }), "agy", "gemini")).toBe("Weekly limit at 90%");
	});
	test("nothing when no weekly window is reported", () => {
		expect(weeklyWarning(usage({ weekly: null, weeklyOpus: null }), "claude", "opus")).toBeNull();
	});
});

describe("formatTokens / contextSummary", () => {
	test("tokens read as k", () => {
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(142000)).toBe("142k");
	});
	test("claude chat with context: figures, percent, cost and turns", () => {
		const s = contextSummary("claude", { used: 142000, window: 200000 }, 0.42, 12);
		expect(s).toEqual({ kind: "claude", used: "142k", window: "200k", pct: 71, cost: "$0.42", turns: "12 turns", canCompact: false });
	});
	test("one turn is singular; compact offered from 80 percent", () => {
		const s = contextSummary("claude", { used: 170000, window: 200000 }, 1, 1);
		expect(s?.kind === "claude" && s.turns).toBe("1 turn");
		expect(s?.kind === "claude" && s.canCompact).toBe(true);
	});
	test("percent is capped at 100", () => {
		const s = contextSummary("claude", { used: 300000, window: 200000 }, 0, 2);
		expect(s?.kind === "claude" && s.pct).toBe(100);
	});
	test("no context yet hides the rail on Claude; Antigravity shows context when reported", () => {
		expect(contextSummary("claude", null, 0, 0)).toBeNull();
		expect(contextSummary("agy", null, 0, 0)).toEqual({ kind: "unreported" });
		expect(contextSummary("agy", { used: 12957, window: 1_000_000 }, 0, 3)).toEqual({
			kind: "claude",
			used: "13.0k",
			window: "1000k",
			pct: 1,
			cost: "Quota",
			turns: "3 turns",
			canCompact: false,
		});
	});
});

describe("agyLimitRows", () => {
	const agySample: AgyUsage = {
		geminiFiveHour: { pct: 2, resetsAt: null },
		geminiWeekly: { pct: 1, resetsAt: null },
		argonWeekly: { pct: 38, resetsAt: null },
		thirdPartyFiveHour: { pct: 0, resetsAt: null },
		thirdPartyWeekly: { pct: 0, resetsAt: null },
	};

	test("Gemini 4 Argon puts Argon weekly first alongside Gemini 5h", () => {
		expect(agyLimitRows(agySample, "gemini-4-argon-high").map((r) => r.label)).toEqual(["Argon wk", "Gemini 5h"]);
	});

	test("Gemini Flash shows Gemini 5h, Gemini wk, and Argon wk", () => {
		expect(agyLimitRows(agySample, "gemini-3.8-flash-high").map((r) => r.label)).toEqual(["Gemini 5h", "Gemini wk", "Argon wk"]);
	});

	test("Claude or GPT inside Antigravity shows 3P 5-hour and 3P Weekly", () => {
		expect(agyLimitRows(agySample, "claude-opus-5-5-high").map((r) => r.label)).toEqual(["3P 5-hour", "3P Weekly"]);
	});
});
