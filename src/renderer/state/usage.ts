import { create } from "zustand";
import type { ClaudeUsage } from "../../shared/usage.ts";
import { createUsagePoller, type UsagePoller } from "./usage-poller.ts";

/**
 * Claude's plan limits for the rails beside the composer. Null until an open
 * Claude chat can answer (its first message has started the session), and
 * whenever the experimental SDK call has nothing readable: the rails hide.
 */

type UsageState = { readonly usage: ClaudeUsage | null };

export const useUsage = create<UsageState>(() => ({ usage: null }));

let poller: UsagePoller | null = null;

/** Starts asking; returns the stop. Called once, from the shell. */
export function startUsagePolling(): () => void {
	const running = createUsagePoller({
		fetch: () => window.teez.agents.usage(),
		publish: (usage) => useUsage.setState({ usage }),
		isVisible: () => document.visibilityState === "visible",
	});
	const onVisibility = (): void => running.visibilityChanged();
	document.addEventListener("visibilitychange", onVisibility);
	poller = running;
	running.start();
	return () => {
		document.removeEventListener("visibilitychange", onVisibility);
		running.stop();
		if (poller === running) poller = null;
	};
}

/** A Claude turn ended (or a session started): ask again once things settle. */
export function usageMayHaveChanged(): void {
	poller?.turnEnded();
}
