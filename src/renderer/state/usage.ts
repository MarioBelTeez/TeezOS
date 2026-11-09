import { create } from "zustand";
import type { AgyUsage, ClaudeUsage } from "../../shared/usage.ts";
import { createUsagePoller, type UsagePoller } from "./usage-poller.ts";

/**
 * Claude's and Antigravity's plan limits for the rails beside the composer.
 */

type UsageState = {
	readonly usage: ClaudeUsage | null;
	readonly agyUsage: AgyUsage | null;
};

export const useUsage = create<UsageState>(() => ({ usage: null, agyUsage: null }));

let poller: UsagePoller | null = null;
let agyPoller: UsagePoller | null = null;

/** Starts asking; returns the stop. Called once, from the shell. */
export function startUsagePolling(): () => void {
	const running = createUsagePoller({
		fetch: () => window.teez.agents.usage(),
		publish: (usage) => useUsage.setState({ usage }),
		isVisible: () => document.visibilityState === "visible",
	});
	const runningAgy = createUsagePoller({
		fetch: (() => window.teez.agents.agyUsage?.() ?? Promise.resolve(null)) as unknown as () => Promise<ClaudeUsage | null>,
		publish: (agyUsage) => useUsage.setState({ agyUsage: agyUsage as unknown as AgyUsage | null }),
		isVisible: () => document.visibilityState === "visible",
	});
	const onVisibility = (): void => {
		running.visibilityChanged();
		runningAgy.visibilityChanged();
	};
	document.addEventListener("visibilitychange", onVisibility);
	poller = running;
	agyPoller = runningAgy;
	running.start();
	runningAgy.start();
	return () => {
		document.removeEventListener("visibilitychange", onVisibility);
		running.stop();
		runningAgy.stop();
		if (poller === running) poller = null;
		if (agyPoller === runningAgy) agyPoller = null;
	};
}

/** A Claude or Antigravity turn ended (or a session started): ask again once things settle. */
export function usageMayHaveChanged(): void {
	poller?.turnEnded();
	agyPoller?.turnEnded();
}
