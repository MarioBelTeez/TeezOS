import { describe, expect, it, vi } from "vitest";
import type { Run } from "../../../runner/src/types.ts";
import { RunsWatcher } from "./runs-watcher.ts";

const run = (id: string, status: Run["status"], extra: Partial<Run> = {}): Run => ({
	id,
	jobId: "j1",
	jobName: "Nightly",
	trigger: "schedule",
	status,
	startedAt: 1,
	endedAt: status === "running" ? null : 2,
	result: "",
	costUsd: 0,
	error: "",
	git: "",
	...extra,
});

function setup(startedByPhone = new Set<string>()) {
	let runs: Run[] = [];
	const notify = vi.fn().mockResolvedValue(undefined);
	const watcher = new RunsWatcher({ client: { runs: async () => runs } as never, push: { notify }, intervalMs: 30_000, startedByPhone });
	return { watcher, notify, set: (next: Run[]) => (runs = next) };
}

describe("runs watcher", () => {
	it("pushes a failed run once", async () => {
		const { watcher, notify, set } = setup();
		await watcher.check();
		set([run("r1", "running")]);
		await watcher.check();
		expect(notify).not.toHaveBeenCalled();
		set([run("r1", "error", { error: "boom" })]);
		await watcher.check();
		await watcher.check();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Nightly failed", url: "/runs/r1", tag: "run-r1" }));
	});

	it("pushes a success only when the phone started it", async () => {
		const { watcher, notify, set } = setup(new Set(["r2"]));
		await watcher.check();
		set([run("r1", "ok"), run("r2", "ok", { trigger: "manual" })]);
		await watcher.check();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Nightly finished", url: "/runs/r2", tag: "run-r2" }));
	});

	it("does not replay finished runs that existed before it started, and stays quiet on a cancel", async () => {
		const { watcher, notify, set } = setup();
		set([run("old", "error")]);
		await watcher.check();
		set([run("old", "error"), run("c1", "cancelled")]);
		await watcher.check();
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("runs watcher bookkeeping", () => {
	it("forgets a phone-started run once it has handled it", async () => {
		const started = new Set(["r2"]);
		const { watcher, set } = setup(started);
		await watcher.check();
		set([run("r2", "ok")]);
		await watcher.check();
		expect(started.has("r2")).toBe(false);
	});
});
