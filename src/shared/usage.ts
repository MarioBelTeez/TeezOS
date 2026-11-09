/**
 * Claude plan limits, as the window shows them beside the composer.
 *
 * The source is the Agent SDK's
 * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, which says of
 * itself that it may change or vanish in any release. So nothing is trusted:
 * every field is checked, anything unexpected becomes null, and an answer
 * with no readable window at all is null too, which hides the rails rather
 * than showing empty bars.
 */

export type UsageWindow = {
	/** Share of the window used, 0-100. */
	readonly pct: number;
	/** When the window resets, epoch ms; null when not given. */
	readonly resetsAt: number | null;
};

export type ModelUsage = UsageWindow & { readonly name: string };

export type ClaudeUsage = {
	readonly fiveHour: UsageWindow | null;
	readonly weekly: UsageWindow | null;
	readonly weeklyOpus: UsageWindow | null;
	readonly weeklySonnet: UsageWindow | null;
	readonly models: readonly ModelUsage[];
};

type Bag = Record<string, unknown>;

const isBag = (value: unknown): value is Bag => typeof value === "object" && value !== null && !Array.isArray(value);

function readWindow(value: unknown): UsageWindow | null {
	if (!isBag(value)) return null;
	const utilization = value["utilization"];
	if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
	return { pct: Math.min(100, Math.max(0, utilization)), resetsAt: readTime(value["resets_at"]) };
}

function readTime(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const at = Date.parse(value);
	return Number.isFinite(at) ? at : null;
}

function readModels(value: unknown): ModelUsage[] {
	if (!Array.isArray(value)) return [];
	const models: ModelUsage[] = [];
	for (const row of value) {
		if (!isBag(row)) continue;
		const name = row["display_name"];
		const window = readWindow(row);
		if (typeof name !== "string" || !name.trim() || !window) continue;
		models.push({ name: name.trim(), ...window });
	}
	return models;
}

export function normaliseUsage(raw: unknown): ClaudeUsage | null {
	if (!isBag(raw) || raw["rate_limits_available"] !== true) return null;
	const limits = raw["rate_limits"];
	if (!isBag(limits)) return null;
	const usage: ClaudeUsage = {
		fiveHour: readWindow(limits["five_hour"]),
		weekly: readWindow(limits["seven_day"]),
		weeklyOpus: readWindow(limits["seven_day_opus"]),
		weeklySonnet: readWindow(limits["seven_day_sonnet"]),
		models: readModels(limits["model_scoped"]),
	};
	const any = usage.fiveHour || usage.weekly || usage.weeklyOpus || usage.weeklySonnet || usage.models.length > 0;
	return any ? usage : null;
}

export type AgyUsage = {
	readonly geminiFiveHour: UsageWindow | null;
	readonly geminiWeekly: UsageWindow | null;
	readonly argonWeekly: UsageWindow | null;
	readonly thirdPartyFiveHour: UsageWindow | null;
	readonly thirdPartyWeekly: UsageWindow | null;
};

function readRemainingWindow(bucket: unknown): UsageWindow | null {
	if (!isBag(bucket)) return null;
	const remaining = bucket["remaining_fraction"];
	if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
	const usedPct = Math.min(100, Math.max(0, (1 - remaining) * 100));
	return { pct: usedPct, resetsAt: readTime(bucket["reset_time"]) };
}

/**
 * Parses `agy -p "/usage" --output-format json` into `AgyUsage`.
 * Antigravity reports `remaining_fraction` (0..1); TeezOS bars show % used (0..100).
 */
export function normaliseAgyUsage(raw: unknown): AgyUsage | null {
	if (!isBag(raw)) return null;
	const command = isBag(raw["command"]) ? raw["command"] : null;
	const data = command && isBag(command["data"]) ? command["data"] : null;
	const groups = data && Array.isArray(data["groups"]) ? data["groups"] : null;
	if (!groups) return null;

	let geminiFiveHour: UsageWindow | null = null;
	let geminiWeekly: UsageWindow | null = null;
	let argonWeekly: UsageWindow | null = null;
	let thirdPartyFiveHour: UsageWindow | null = null;
	let thirdPartyWeekly: UsageWindow | null = null;

	for (const group of groups) {
		if (!isBag(group) || !Array.isArray(group["buckets"])) continue;
		for (const bucket of group["buckets"]) {
			if (!isBag(bucket)) continue;
			const id = typeof bucket["id"] === "string" ? bucket["id"].toLowerCase() : "";
			const win = readRemainingWindow(bucket);
			if (!win) continue;
			if (id === "gemini-5h") geminiFiveHour = win;
			else if (id === "gemini-weekly") geminiWeekly = win;
			else if (id.includes("argon")) argonWeekly = win;
			else if (id === "3p-5h") thirdPartyFiveHour = win;
			else if (id === "3p-weekly") thirdPartyWeekly = win;
		}
	}

	const any = geminiFiveHour || geminiWeekly || argonWeekly || thirdPartyFiveHour || thirdPartyWeekly;
	return any
		? {
				geminiFiveHour,
				geminiWeekly,
				argonWeekly,
				thirdPartyFiveHour,
				thirdPartyWeekly,
		  }
		: null;
}
