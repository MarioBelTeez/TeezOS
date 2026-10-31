import { describe, expect, test } from "vitest";
import type { QueryFn, QueryHandle, QueryParams } from "./service.ts";
import { PROBE_MIN_INTERVAL_MS, UsageProbe, probeDecision } from "./usage-probe.ts";

const RAW = { rate_limits_available: true, rate_limits: { five_hour: { utilization: 42, resets_at: "2026-10-15T20:00:00Z" } } };

describe("probeDecision", () => {
	test("runs when nothing is out and the last probe is old or absent", () => {
		expect(probeDecision({ now: 1_000_000, lastAt: null, inFlight: false })).toBe("run");
		expect(probeDecision({ now: 1_000_000, lastAt: 1_000_000 - PROBE_MIN_INTERVAL_MS, inFlight: false })).toBe("run");
	});

	test("joins the probe already out, never starts a second", () => {
		expect(probeDecision({ now: 1_000_000, lastAt: null, inFlight: true })).toBe("join");
		expect(probeDecision({ now: 1_000_000, lastAt: 0, inFlight: true })).toBe("join");
	});

	test("answers from the last probe when it is under 2 minutes old", () => {
		expect(probeDecision({ now: 1_000_000, lastAt: 1_000_000 - PROBE_MIN_INTERVAL_MS + 1, inFlight: false })).toBe("cached");
	});
});

type Fake = {
	readonly query: QueryFn;
	readonly calls: QueryParams[];
	readonly closed: { count: number };
	/** Messages the prompt stream was asked for and delivered. */
	readonly delivered: unknown[];
	readonly resolveUsage: (value: unknown) => void;
};

function fake(options: { usage?: () => Promise<unknown> } = {}): Fake {
	const calls: QueryParams[] = [];
	const closed = { count: 0 };
	const delivered: unknown[] = [];
	let resolveUsage: (value: unknown) => void = () => undefined;
	const query: QueryFn = (params) => {
		calls.push(params);
		const handle = {
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => options.usage?.() ?? new Promise((resolve) => (resolveUsage = resolve)),
			close: () => void (closed.count += 1),
			interrupt: () => Promise.resolve(),
			next: () => new Promise(() => undefined),
			return: () => Promise.resolve({ value: undefined, done: true }),
			throw: () => Promise.resolve({ value: undefined, done: true }),
			[Symbol.asyncIterator]() {
				return this;
			},
		} as unknown as QueryHandle;
		if (typeof params.prompt !== "string") {
			const iterator = params.prompt[Symbol.asyncIterator]();
			void iterator.next().then((r) => {
				if (!r.done) delivered.push(r.value);
			});
		}
		return handle;
	};
	return { query, calls, closed, delivered, resolveUsage: (v) => resolveUsage(v) };
}

const make = (f: Fake, clock = { now: 5_000_000 }, timeoutMs = 50) =>
	new UsageProbe({ query: f.query, claudePath: "claude.exe", cwd: "C:\\Users\\x", now: () => clock.now, timeoutMs });

describe("UsageProbe", () => {
	test("asks with no hooks, no MCP, no tools and no settings, and sends no message", async () => {
		const f = fake({ usage: () => Promise.resolve(RAW) });
		const usage = await make(f).get();
		expect(usage?.fiveHour?.pct).toBe(42);
		const [call] = f.calls;
		expect(call?.options).toMatchObject({ settingSources: [], tools: [], strictMcpConfig: true, mcpServers: {}, permissionMode: "plan" });
		expect(typeof call?.prompt).not.toBe("string");
		await new Promise((r) => setTimeout(r, 5));
		expect(f.delivered).toEqual([]);
	});

	test("closes the query after the answer", async () => {
		const f = fake({ usage: () => Promise.resolve(RAW) });
		await make(f).get();
		expect(f.closed.count).toBe(1);
	});

	test("two callers at once share one probe", async () => {
		const f = fake();
		const probe = make(f, { now: 5_000_000 }, 1000);
		const a = probe.get();
		const b = probe.get();
		await Promise.resolve();
		f.resolveUsage(RAW);
		const [ua, ub] = await Promise.all([a, b]);
		expect(f.calls).toHaveLength(1);
		expect(ua).toEqual(ub);
	});

	test("a second ask within 2 minutes is answered without a new probe", async () => {
		const f = fake({ usage: () => Promise.resolve(RAW) });
		const clock = { now: 5_000_000 };
		const probe = make(f, clock);
		await probe.get();
		clock.now += 60_000;
		expect((await probe.get())?.fiveHour?.pct).toBe(42);
		expect(f.calls).toHaveLength(1);
		clock.now += PROBE_MIN_INTERVAL_MS;
		await probe.get();
		expect(f.calls).toHaveLength(2);
	});

	test("an answer that never comes is given up on, and the query is closed", async () => {
		const f = fake();
		const usage = await make(f, { now: 5_000_000 }, 20).get();
		expect(usage).toBeNull();
		expect(f.closed.count).toBe(1);
	});

	test("a query that throws is null, not a crash", async () => {
		const probe = new UsageProbe({
			query: () => {
				throw new Error("spawn failed");
			},
			claudePath: "claude.exe",
			cwd: "C:\\Users\\x",
			now: () => 1,
			timeoutMs: 20,
		});
		expect(await probe.get()).toBeNull();
	});

	test("dispose closes a probe in flight", async () => {
		const f = fake();
		const probe = make(f, { now: 5_000_000 }, 1000);
		const pending = probe.get();
		await Promise.resolve();
		probe.dispose();
		expect(await pending).toBeNull();
		expect(f.closed.count).toBe(1);
	});
});
