import type { ClaudeUsage } from "../../shared/usage.ts";

/**
 * When the window asks for Claude's plan limits: once at start, 2 s after a
 * Claude turn ends (a burst of turns is one request), and every 2 minutes
 * while the window is visible. Requests never overlap; one asked for while
 * another is out runs when it answers, so a turn's cost is never missed.
 */

export const USAGE_DEBOUNCE_MS = 2_000;
export const USAGE_INTERVAL_MS = 120_000;

export type UsagePoller = {
	readonly start: () => void;
	readonly stop: () => void;
	/** A Claude turn ended: its usage counts against the limits now. */
	readonly turnEnded: () => void;
	/** The document's visibility changed; back in view with a stale answer asks again. */
	readonly visibilityChanged: () => void;
};

export function createUsagePoller(deps: {
	readonly fetch: () => Promise<ClaudeUsage | null>;
	readonly publish: (usage: ClaudeUsage | null) => void;
	readonly isVisible: () => boolean;
}): UsagePoller {
	let stopped = true;
	let inFlight = false;
	let again = false;
	let lastAsked = Number.NEGATIVE_INFINITY;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;

	const refresh = async (): Promise<void> => {
		if (stopped) return;
		if (inFlight) {
			again = true;
			return;
		}
		inFlight = true;
		lastAsked = Date.now();
		let usage: ClaudeUsage | null;
		try {
			usage = await deps.fetch();
		} catch {
			usage = null;
		}
		inFlight = false;
		if (stopped) return;
		deps.publish(usage);
		if (again) {
			again = false;
			void refresh();
		}
	};

	return {
		start: () => {
			if (!stopped) return;
			stopped = false;
			void refresh();
			interval = setInterval(() => {
				if (deps.isVisible()) void refresh();
			}, USAGE_INTERVAL_MS);
		},
		stop: () => {
			stopped = true;
			again = false;
			clearTimeout(debounce);
			clearInterval(interval);
		},
		turnEnded: () => {
			if (stopped) return;
			clearTimeout(debounce);
			debounce = setTimeout(() => void refresh(), USAGE_DEBOUNCE_MS);
		},
		visibilityChanged: () => {
			if (deps.isVisible() && Date.now() - lastAsked >= USAGE_INTERVAL_MS) void refresh();
		},
	};
}
