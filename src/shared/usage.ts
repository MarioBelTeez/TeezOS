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
