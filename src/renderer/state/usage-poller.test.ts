import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { USAGE_DEBOUNCE_MS, USAGE_INTERVAL_MS, createUsagePoller } from "./usage-poller.ts";
import type { ClaudeUsage } from "../../shared/usage.ts";

const usage = (pct: number): ClaudeUsage => ({ fiveHour: { pct, resetsAt: null }, weekly: null, weeklyOpus: null, weeklySonnet: null, models: [] });

/** A fetch whose answers the test releases one by one. */
function controlledFetch() {
	const pending: ((value: ClaudeUsage | null) => void)[] = [];
	const fetch = vi.fn(() => new Promise<ClaudeUsage | null>((resolve) => pending.push(resolve)));
	const answer = async (value: ClaudeUsage | null): Promise<void> => {
		pending.shift()?.(value);
		await vi.advanceTimersByTimeAsync(0);
	};
	return { fetch, answer, pending };
}

describe("createUsagePoller", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	test("asks once on start and publishes the answer", async () => {
		const { fetch, answer } = controlledFetch();
		const published: (ClaudeUsage | null)[] = [];
		const poller = createUsagePoller({ fetch, publish: (u) => published.push(u), isVisible: () => true });
		poller.start();
		expect(fetch).toHaveBeenCalledTimes(1);
		await answer(usage(10));
		expect(published).toEqual([usage(10)]);
		poller.stop();
	});

	test("a turn's end asks again after a 2 s quiet spell; several ends make one request", async () => {
		const { fetch, answer } = controlledFetch();
		const poller = createUsagePoller({ fetch, publish: () => undefined, isVisible: () => true });
		poller.start();
		await answer(null);
		poller.turnEnded();
		await vi.advanceTimersByTimeAsync(1500);
		poller.turnEnded();
		await vi.advanceTimersByTimeAsync(1999);
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(USAGE_DEBOUNCE_MS).toBe(2000);
		expect(fetch).toHaveBeenCalledTimes(2);
		poller.stop();
	});

	test("every 2 minutes while the window is visible, not while hidden", async () => {
		const { fetch, answer } = controlledFetch();
		let visible = true;
		const poller = createUsagePoller({ fetch, publish: () => undefined, isVisible: () => visible });
		poller.start();
		await answer(null);
		await vi.advanceTimersByTimeAsync(USAGE_INTERVAL_MS);
		expect(fetch).toHaveBeenCalledTimes(2);
		await answer(null);
		visible = false;
		await vi.advanceTimersByTimeAsync(USAGE_INTERVAL_MS * 3);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(USAGE_INTERVAL_MS).toBe(120_000);
		poller.stop();
	});

	test("coming back into view asks at once when the last answer is stale", async () => {
		const { fetch, answer } = controlledFetch();
		let visible = true;
		const poller = createUsagePoller({ fetch, publish: () => undefined, isVisible: () => visible });
		poller.start();
		await answer(null);
		visible = false;
		await vi.advanceTimersByTimeAsync(USAGE_INTERVAL_MS + 1000);
		visible = true;
		poller.visibilityChanged();
		expect(fetch).toHaveBeenCalledTimes(2);
		await answer(null);
		// Fresh: flicking back and forth does not ask again.
		poller.visibilityChanged();
		expect(fetch).toHaveBeenCalledTimes(2);
		poller.stop();
	});

	test("never two requests at once: a request asked for meanwhile runs once the first answers", async () => {
		const { fetch, answer } = controlledFetch();
		const published: (ClaudeUsage | null)[] = [];
		const poller = createUsagePoller({ fetch, publish: (u) => published.push(u), isVisible: () => true });
		poller.start();
		poller.turnEnded();
		await vi.advanceTimersByTimeAsync(USAGE_DEBOUNCE_MS);
		poller.turnEnded();
		await vi.advanceTimersByTimeAsync(USAGE_DEBOUNCE_MS);
		expect(fetch).toHaveBeenCalledTimes(1);
		await answer(usage(1));
		expect(fetch).toHaveBeenCalledTimes(2);
		await answer(usage(2));
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(published).toEqual([usage(1), usage(2)]);
		poller.stop();
	});

	test("a failed request publishes null (rails hidden) and does not stop the polling", async () => {
		const fetch = vi.fn<() => Promise<ClaudeUsage | null>>().mockRejectedValueOnce(new Error("ipc")).mockResolvedValue(usage(5));
		const published: (ClaudeUsage | null)[] = [];
		const poller = createUsagePoller({ fetch, publish: (u) => published.push(u), isVisible: () => true });
		poller.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(USAGE_INTERVAL_MS);
		expect(published).toEqual([null, usage(5)]);
		poller.stop();
	});

	test("after stop nothing is asked or published", async () => {
		const { fetch, answer } = controlledFetch();
		const published: (ClaudeUsage | null)[] = [];
		const poller = createUsagePoller({ fetch, publish: (u) => published.push(u), isVisible: () => true });
		poller.start();
		poller.turnEnded();
		poller.stop();
		await answer(usage(1));
		await vi.advanceTimersByTimeAsync(USAGE_INTERVAL_MS * 2);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(published).toEqual([]);
	});
});
