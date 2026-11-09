import { describe, expect, test } from "vitest";
import { normaliseAgyUsage, normaliseUsage } from "./usage.ts";

/** Shaped like the SDK's SDKControlGetUsageResponse (0.3.273), trimmed to what is read. */
function response(rateLimits: unknown, available = true): Record<string, unknown> {
	return {
		session: { total_cost_usd: 0 },
		subscription_type: "max",
		rate_limits_available: available,
		rate_limits: rateLimits,
		behaviors: null,
	};
}

const FIVE = { utilization: 42, resets_at: "2026-10-14T20:00:00Z" };
const WEEK = { utilization: 18.5, resets_at: "2026-10-18T09:30:00.000Z" };

describe("normaliseUsage", () => {
	test("reads every window, percentages as numbers and reset times as epoch ms", () => {
		expect(
			normaliseUsage(
				response({
					five_hour: FIVE,
					seven_day: WEEK,
					seven_day_opus: { utilization: 7, resets_at: null },
					seven_day_sonnet: null,
					model_scoped: [{ display_name: "Fable", utilization: 3, resets_at: "2026-10-18T09:30:00Z" }],
				}),
			),
		).toEqual({
			fiveHour: { pct: 42, resetsAt: Date.parse("2026-10-14T20:00:00Z") },
			weekly: { pct: 18.5, resetsAt: Date.parse("2026-10-18T09:30:00Z") },
			weeklyOpus: { pct: 7, resetsAt: null },
			weeklySonnet: null,
			models: [{ name: "Fable", pct: 3, resetsAt: Date.parse("2026-10-18T09:30:00Z") }],
		});
	});

	test("clamps percentages to 0-100", () => {
		const usage = normaliseUsage(response({ five_hour: { utilization: 130, resets_at: null }, seven_day: { utilization: -4, resets_at: null } }));
		expect(usage?.fiveHour?.pct).toBe(100);
		expect(usage?.weekly?.pct).toBe(0);
	});

	test("a window with no utilisation, or a non-numeric one, is absent", () => {
		const usage = normaliseUsage(
			response({ five_hour: FIVE, seven_day: { utilization: null, resets_at: null }, seven_day_opus: { utilization: "12", resets_at: null }, seven_day_sonnet: { utilization: Number.NaN, resets_at: null } }),
		);
		expect(usage?.weekly).toBeNull();
		expect(usage?.weeklyOpus).toBeNull();
		expect(usage?.weeklySonnet).toBeNull();
	});

	test("an unreadable reset time is null, the window kept", () => {
		const usage = normaliseUsage(response({ five_hour: { utilization: 10, resets_at: "soon" }, seven_day: { utilization: 10, resets_at: 1234 } }));
		expect(usage?.fiveHour).toEqual({ pct: 10, resetsAt: null });
		expect(usage?.weekly).toEqual({ pct: 10, resetsAt: null });
	});

	test("model rows without a name or a utilisation are skipped; a non-array is no rows", () => {
		expect(
			normaliseUsage(response({ five_hour: FIVE, model_scoped: [{ display_name: "", utilization: 3 }, { utilization: 3 }, { display_name: "X", utilization: null }, "junk", { display_name: "Y", utilization: 150, resets_at: null }] }))?.models,
		).toEqual([{ name: "Y", pct: 100, resetsAt: null }]);
		expect(normaliseUsage(response({ five_hour: FIVE, model_scoped: { display_name: "X" } }))?.models).toEqual([]);
	});

	test("plan limits not available (API key, Bedrock) is null", () => {
		expect(normaliseUsage(response({ five_hour: FIVE }, false))).toBeNull();
		expect(normaliseUsage(response(null))).toBeNull();
	});

	test("unknown shapes are null, never a throw", () => {
		for (const raw of [undefined, null, 42, "usage", [], {}, { rate_limits_available: "yes", rate_limits: { five_hour: FIVE } }, response("limits"), response([FIVE])]) {
			expect(normaliseUsage(raw)).toBeNull();
		}
	});

	test("an answer with no window at all is null, so the rails stay hidden", () => {
		expect(normaliseUsage(response({}))).toBeNull();
		expect(normaliseUsage(response({ five_hour: null, seven_day: { utilization: null, resets_at: null }, model_scoped: [] }))).toBeNull();
	});
});

describe("normaliseAgyUsage", () => {
	test("converts remaining_fraction into used pct and parses reset_time across Gemini, Argon, and 3P buckets", () => {
		const raw = {
			status: "SUCCESS",
			command: {
				name: "usage",
				data: {
					groups: [
						{
							name: "Gemini Models",
							buckets: [
								{ id: "gemini-weekly", remaining_fraction: 0.99, reset_time: "2026-11-14T18:51:42Z" },
								{ id: "gemini-5h", remaining_fraction: 0.98, reset_time: "2026-11-10T00:46:21Z" },
							],
						},
						{
							name: "Claude and GPT models",
							buckets: [
								{ id: "3p-weekly", remaining_fraction: 1, reset_time: "2026-11-16T22:30:15Z" },
								{ id: "3p-5h", remaining_fraction: 0.75, reset_time: "2026-11-10T03:30:15Z" },
							],
						},
						{
							name: "Gemini 4 Argon",
							buckets: [
								{ id: "gemini-argon-wtu-weekly", remaining_fraction: 0.62, reset_time: "2026-11-14T02:03:09Z" },
							],
						},
					],
				},
			},
		};
		const parsed = normaliseAgyUsage(raw);
		expect(parsed).not.toBeNull();
		expect(parsed?.geminiFiveHour?.pct).toBeCloseTo(2, 5);
		expect(parsed?.geminiWeekly?.pct).toBeCloseTo(1, 5);
		expect(parsed?.argonWeekly?.pct).toBeCloseTo(38, 5);
		expect(parsed?.argonWeekly?.resetsAt).toBe(Date.parse("2026-11-14T02:03:09Z"));
		expect(parsed?.thirdPartyFiveHour?.pct).toBeCloseTo(25, 5);
		expect(parsed?.thirdPartyWeekly?.pct).toBeCloseTo(0, 5);
	});

	test("returns null on malformed or empty payloads", () => {
		expect(normaliseAgyUsage(null)).toBeNull();
		expect(normaliseAgyUsage({})).toBeNull();
		expect(normaliseAgyUsage({ command: { data: { groups: [] } } })).toBeNull();
	});
});
