import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PresenceService, RETRY_MS, MIN_GAP_MS, type IpcLike } from "./service.ts";
import type { Activity } from "./presence.ts";

class FakeIpc implements IpcLike {
	sent: unknown[] = [];
	closed = false;
	#onClose: () => void = () => {};
	constructor(readonly fail: boolean) {}
	connect(): Promise<void> {
		return this.fail ? Promise.reject(new Error("Discord is not running.")) : Promise.resolve();
	}
	setActivity(activity: unknown): void {
		this.sent.push(activity);
	}
	close(): void {
		this.closed = true;
	}
	onClose(listener: () => void): void {
		this.#onClose = listener;
	}
	drop(): void {
		this.#onClose();
	}
}

const activity = (details: string): Activity => ({
	details,
	timestamps: { start: 1 },
	assets: { large_image: "teezai", large_text: "TeezAI" },
});

describe("PresenceService", () => {
	let made: FakeIpc[];
	let failNext: boolean[];
	let current: Activity | null;
	let service: PresenceService;

	beforeEach(() => {
		vi.useFakeTimers();
		made = [];
		failNext = [];
		current = activity("Idle");
		service = new PresenceService(
			() => {
				const ipc = new FakeIpc(failNext.shift() ?? false);
				made.push(ipc);
				return ipc;
			},
			() => current,
		);
	});

	afterEach(() => {
		service.stop();
		vi.useRealTimers();
	});

	test("connects and sends the current activity", async () => {
		service.refresh();
		await vi.advanceTimersByTimeAsync(0);
		expect(made).toHaveLength(1);
		expect(made[0]?.sent).toEqual([activity("Idle")]);
	});

	test("Discord closed: retries quietly until it opens", async () => {
		failNext = [true, true];
		service.refresh();
		await vi.advanceTimersByTimeAsync(0);
		expect(made).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(RETRY_MS);
		expect(made).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(RETRY_MS);
		expect(made).toHaveLength(3);
		expect(made[2]?.sent).toEqual([activity("Idle")]);
	});

	test("an unchanged activity is not sent again", async () => {
		service.refresh();
		await vi.advanceTimersByTimeAsync(0);
		service.refresh();
		await vi.advanceTimersByTimeAsync(MIN_GAP_MS * 2);
		expect(made[0]?.sent).toHaveLength(1);
	});

	test("bursts are throttled, and the last state always lands", async () => {
		service.refresh();
		await vi.advanceTimersByTimeAsync(0);
		for (const d of ["a", "b", "c", "d"]) {
			current = activity(d);
			service.refresh();
		}
		expect(made[0]?.sent).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(MIN_GAP_MS);
		expect(made[0]?.sent).toEqual([activity("Idle"), activity("d")]);
	});

	test("turning it off clears the status and stops trying", async () => {
		service.refresh();
		await vi.advanceTimersByTimeAsync(0);
		current = null;
		service.refresh();
		await vi.advanceTimersByTimeAsync(MIN_GAP_MS);
		expect(made[0]?.sent.at(-1)).toBeNull();
		expect(made[0]?.closed).toBe(true);
		await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
		expect(made).toHaveLength(1);
	});

	test("off while Discord is closed never connects", async () => {
		current = null;
		service.refresh();
		await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
		expect(made).toHaveLength(0);
	});

	test("Discord quitting mid-session reconnects and resends", async () => {
		service.refresh();
		await vi.advanceTimersByTimeAsync(0);
		made[0]?.drop();
		await vi.advanceTimersByTimeAsync(RETRY_MS);
		expect(made).toHaveLength(2);
		expect(made[1]?.sent).toEqual([activity("Idle")]);
	});

	test("stop clears the status and closes", async () => {
		service.refresh();
		await vi.advanceTimersByTimeAsync(0);
		service.stop();
		expect(made[0]?.sent.at(-1)).toBeNull();
		expect(made[0]?.closed).toBe(true);
		await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
		expect(made).toHaveLength(1);
	});
});
