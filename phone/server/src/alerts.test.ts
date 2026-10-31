import { describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../../src/main/proxmox/watch.ts";
import { AlertWatcher } from "./alerts.ts";

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
	at: 1000,
	reachable: true,
	ups: null,
	guests: [{ vmid: 100, name: "adguard", status: "running" }],
	zfs: [],
	disks: [],
	tasks: [],
	...over,
});
const stopped = (): Snapshot => snap({ guests: [{ vmid: 100, name: "adguard", status: "stopped" }] });

function make(results: (Snapshot | Error)[]) {
	const queue = [...results];
	const notify = vi.fn(async (_payload: unknown) => undefined);
	const look = vi.fn(async (_since?: number) => {
		const next = queue.shift();
		if (!next) throw new Error("no more");
		if (next instanceof Error) throw next;
		return next;
	});
	const watcher = new AlertWatcher({ look, push: { notify } as never, intervalMs: 300_000, now: () => 5_000_000 });
	return { watcher, notify, look };
}

describe("AlertWatcher", () => {
	it("pushes an alert once until it clears", async () => {
		const { watcher, notify } = make([snap(), stopped(), stopped(), snap(), stopped()]);
		await watcher.check(); // baseline
		await watcher.check(); // stopped -> push
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toMatchObject({ title: "adguard stopped", url: "/server", tag: "server-guest-100" });
		await watcher.check(); // still stopped -> quiet
		expect(notify).toHaveBeenCalledTimes(1);
		await watcher.check(); // running again clears
		await watcher.check(); // stops again -> push again
		expect(notify).toHaveBeenCalledTimes(2);
	});

	it("does not repeat not-answering while the server stays silent, and tells when it is back", async () => {
		const down = new Error("down");
		const { watcher, notify } = make([snap(), down, down, down, snap()]);
		await watcher.check();
		await watcher.check();
		await watcher.check(); // second miss -> unreachable
		expect(notify).toHaveBeenCalledTimes(1);
		await watcher.check(); // still silent, already told
		expect(notify).toHaveBeenCalledTimes(1);
		await watcher.check(); // back
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify.mock.calls[1]?.[0]).toMatchObject({ title: "Proxmox is answering again" });
	});

	it("says not answering only after two misses", async () => {
		const down = new Error("down");
		const { watcher, notify } = make([snap(), down, snap(), down, down]);
		await watcher.check();
		await watcher.check(); // one miss
		await watcher.check(); // answered again: misses reset
		await watcher.check(); // one miss
		expect(notify).not.toHaveBeenCalled();
		await watcher.check(); // second in a row
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toMatchObject({ title: "Proxmox is not answering" });
	});

	it("passes the previous look time to the next look and survives a failing push", async () => {
		const { watcher, look, notify } = make([snap({ at: 111 }), stopped()]);
		notify.mockRejectedValueOnce(new Error("push down"));
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await watcher.check();
		await watcher.check();
		expect(look.mock.calls[1]?.[0]).toBe(111);
		spy.mockRestore();
	});

	it("start looks at once and then every interval; stop ends it", async () => {
		vi.useFakeTimers();
		try {
			const { watcher, look } = make([snap(), snap(), snap()]);
			watcher.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(look).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(300_000);
			expect(look).toHaveBeenCalledTimes(2);
			watcher.stop();
			await vi.advanceTimersByTimeAsync(600_000);
			expect(look).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
