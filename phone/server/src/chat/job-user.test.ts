import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobUser, KILL_GRACE_MS, stopChild, type ChildLike, type Spawn } from "./job-user.ts";

function child(): ChildLike & { signals: (string | undefined)[]; close: () => void } {
	const emitter = new EventEmitter();
	const signals: (string | undefined)[] = [];
	return {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		on: (event: string, listener: never) => emitter.on(event, listener),
		kill: (signal?: string) => signals.push(signal),
		signals,
		close: () => emitter.emit("close", null),
	} as never;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("stopChild", () => {
	it("asks politely, and does nothing more when the process ends in time", async () => {
		const c = child();
		let closed: () => void = () => undefined;
		const killSurvivors = vi.fn();
		stopChild(c, new Promise<void>((resolve) => (closed = resolve)), killSurvivors);
		expect(c.signals).toEqual([undefined]);
		closed();
		await vi.advanceTimersByTimeAsync(KILL_GRACE_MS + 1);
		expect(c.signals).toEqual([undefined]);
		expect(killSurvivors).not.toHaveBeenCalled();
	});

	it("escalates to SIGKILL and kills the job user's survivors 10 s after a stop that did not end it", async () => {
		const c = child();
		const killSurvivors = vi.fn();
		stopChild(c, new Promise<void>(() => undefined), killSurvivors);
		await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
		expect(c.signals).toEqual([undefined]);
		await vi.advanceTimersByTimeAsync(2);
		expect(c.signals).toEqual([undefined, "SIGKILL"]);
		expect(killSurvivors).toHaveBeenCalledTimes(1);
	});
});

describe("JobUser.killSurvivors", () => {
	it("kills every process of the job user, as the job user", async () => {
		vi.useRealTimers();
		const calls: { file: string; args: readonly string[] }[] = [];
		const spawn: Spawn = (file, args) => {
			calls.push({ file, args });
			const c = child();
			setTimeout(() => c.close(), 1);
			return c;
		};
		await new JobUser(spawn, "phoneagent").killSurvivors();
		expect(calls[0]?.file).toBe("sudo");
		expect(calls[0]?.args).toEqual(expect.arrayContaining(["-u", "phoneagent", "pkill", "-KILL", "-u", "phoneagent"]));
	});

	it("does nothing without a job user (the child itself was the process)", async () => {
		const spawn = vi.fn();
		await new JobUser(spawn as never, undefined).killSurvivors();
		expect(spawn).not.toHaveBeenCalled();
	});
});
