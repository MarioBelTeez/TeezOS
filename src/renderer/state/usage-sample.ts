import type { ClaudeUsage } from "../../shared/usage.ts";

/**
 * Plan limits for the dev window capture only: a capture sends no message, so
 * no Claude session is live to report real ones and the rails would never be
 * photographed. One bar in each tone (red, amber, red-hot). Used from App's
 * `import.meta.env.DEV` block; production builds drop it with that block.
 */
export function sampleUsage(now: number): ClaudeUsage {
	const minute = 60_000;
	return {
		fiveHour: { pct: 62, resetsAt: now + (2 * 60 + 14) * minute },
		weekly: { pct: 81, resetsAt: now + (3 * 24 * 60 + 4 * 60 + 20) * minute },
		weeklyOpus: { pct: 93, resetsAt: now + (3 * 24 * 60 + 4 * 60 + 20) * minute },
		weeklySonnet: { pct: 12, resetsAt: now + (3 * 24 * 60 + 4 * 60 + 20) * minute },
		models: [],
	};
}
