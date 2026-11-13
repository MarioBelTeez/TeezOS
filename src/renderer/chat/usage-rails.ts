import type { AgentKind } from "../../main/agents/registry.ts";
import type { AgyUsage, ClaudeUsage, UsageWindow } from "../../shared/usage.ts";

/**
 * The rails either side of the composer: Claude's 5-hour limit on the left,
 * the week on the right. Only the pure parts live here, so they can be tested:
 * whether there is room, how a reset time reads, which colour a bar takes.
 */

/** Each side needs this much free space beside the composer, or no rail shows. */
export const RAIL_MIN_SPACE = 180;
/** Past this a rail stops growing; a very wide window keeps it compact. */
export const RAIL_MAX_WIDTH = 240;
/** Space kept between a rail and the composer. */
export const RAIL_GAP = 24;

const MINUTE = 60_000;

/** "resets in 2h 14m", "resets in 3d 4h", "resets in 14m"; null when the time is unknown. */
export function formatResetsIn(resetsAt: number | null, now: number): string | null {
	if (resetsAt === null) return null;
	const ms = resetsAt - now;
	if (ms <= 0) return "resets now";
	// Rounded up: a window resetting in 20 seconds still has a minute to go, never "0m".
	const minutes = Math.ceil(ms / MINUTE);
	const days = Math.floor(minutes / (24 * 60));
	const hours = Math.floor((minutes % (24 * 60)) / 60);
	const rest = minutes % 60;
	if (days > 0) return `resets in ${days}d${hours ? ` ${hours}h` : ""}`;
	if (hours > 0) return `resets in ${hours}h${rest ? ` ${rest}m` : ""}`;
	return `resets in ${rest}m`;
}

export function formatPct(pct: number): string {
	return `${Math.round(pct)}%`;
}

export type BarTone = "normal" | "warn" | "hot";

/** Red as usual, amber from 75 %, glowing red-hot from 90 %. */
export function barTone(pct: number): BarTone {
	if (pct >= 90) return "hot";
	if (pct >= 75) return "warn";
	return "normal";
}

/**
 * How wide each rail is, given the composer row's width and the composer's;
 * null when either side has less than `RAIL_MIN_SPACE` free (they never overlap the composer).
 */
export function railLayout(rowWidth: number, composerWidth: number): { readonly width: number; readonly gap: number } | null {
	const free = (rowWidth - composerWidth) / 2;
	if (!(free >= RAIL_MIN_SPACE)) return null;
	return { width: Math.min(RAIL_MAX_WIDTH, free - RAIL_GAP), gap: RAIL_GAP };
}

/**
 * The weekly share of the model this chat runs on: Opus (Claude Code's
 * default) or Sonnet. A per-model row naming the family stands in when the
 * plan reports no window of its own for it.
 */
export function weeklyShare(usage: ClaudeUsage, agent: AgentKind, model: string): { readonly label: string; readonly window: UsageWindow } | null {
	if (agent !== "claude") return null;
	const id = (model || "opus").toLowerCase();
	const family = id.includes("opus") ? "Opus" : id.includes("sonnet") ? "Sonnet" : null;
	if (!family) return null;
	const own = family === "Opus" ? usage.weeklyOpus : usage.weeklySonnet;
	if (own) return { label: family, window: own };
	const row = usage.models.find((m) => m.name.toLowerCase().includes(family.toLowerCase()));
	return row ? { label: family, window: { pct: row.pct, resetsAt: row.resetsAt } } : null;
}

export type LimitRow = { readonly label: string; readonly window: UsageWindow; readonly size: "main" | "share" };

/** The left rail shows the 5-hour bar only; the week is a warning line (see `weeklyWarning`). */
export function limitRows(usage: ClaudeUsage): readonly LimitRow[] {
	return usage.fiveHour ? [{ label: "5-hour", window: usage.fiveHour, size: "main" }] : [];
}

/**
 * Antigravity plan limits for the left rail, putting the active model's buckets
 * first and keeping all other available buckets below so everything can be
 * scrolled without switching models.
 */
export function agyLimitRows(usage: AgyUsage, model: string): readonly LimitRow[] {
	const id = model.toLowerCase();
	const all: readonly (readonly [string, UsageWindow | null])[] = [
		["Gemini 5h", usage.geminiFiveHour],
		["Gemini wk", usage.geminiWeekly],
		["Argon wk", usage.argonWeekly],
		["3P 5-hour", usage.thirdPartyFiveHour],
		["3P Weekly", usage.thirdPartyWeekly],
	];
	const priority =
		id.includes("claude") || id.includes("opus") || id.includes("sonnet") || id.includes("gpt")
			? ["3P 5-hour", "3P Weekly"]
			: id.includes("argon")
				? ["Argon wk", "Gemini 5h"]
				: ["Gemini 5h", "Gemini wk", "Argon wk"];
	const ordered = [...priority, ...all.map(([label]) => label).filter((label) => !priority.includes(label))];
	const byLabel = new Map(all);
	const rows: LimitRow[] = [];
	for (const label of ordered) {
		const window = byLabel.get(label);
		if (window) rows.push({ label, window, size: "main" });
	}
	return rows;
}

/** The weekly limit speaks up from this share. */
export const WEEKLY_WARN_FROM_PCT = 75;

/**
 * "Weekly limit at 81%" once the week, or this chat's model's share of it
 * (whichever is higher), reaches 75 %; null below that or when none is reported.
 */
export function weeklyWarning(usage: ClaudeUsage, agent: AgentKind, model: string): string | null {
	const share = weeklyShare(usage, agent, model);
	const pcts = [usage.weekly?.pct, share?.window.pct].filter((p): p is number => p !== undefined);
	if (pcts.length === 0) return null;
	const highest = Math.max(...pcts);
	return highest >= WEEKLY_WARN_FROM_PCT ? `Weekly limit at ${formatPct(highest)}` : null;
}

/** Compact appears from this share of the context window. */
export const COMPACT_FROM_PCT = 80;

/** 950, 1.5k, 142k. */
export function formatTokens(count: number): string {
	return count >= 1000 ? `${(count / 1000).toFixed(count >= 100000 ? 0 : 1)}k` : String(count);
}

export type ContextSummary =
	| { readonly kind: "unreported" }
	| {
			readonly kind: "claude";
			readonly used: string;
			readonly window: string;
			readonly pct: number;
			readonly cost: string;
			readonly turns: string;
			readonly canCompact: boolean;
	  };

/** What the right rail shows; null (hidden) until a Claude chat has reported its context. */
export function contextSummary(
	agent: AgentKind,
	context: { readonly used: number; readonly window: number } | null,
	totalCostUsd: number,
	turns: number,
): ContextSummary | null {
	if (agent === "codex") return { kind: "unreported" };
	if (!context || !(context.window > 0)) {
		return agent === "agy" ? { kind: "unreported" } : null;
	}
	const pct = Math.min(100, Math.round((context.used / context.window) * 100));
	return {
		kind: "claude",
		used: formatTokens(context.used),
		window: formatTokens(context.window),
		pct,
		cost: agent === "agy" ? "Quota" : `$${totalCostUsd.toFixed(2)}`,
		turns: `${turns} ${turns === 1 ? "turn" : "turns"}`,
		canCompact: pct >= COMPACT_FROM_PCT,
	};
}
