import { describe, expect, test } from "vitest";
import { matches, nextRun, parseCron } from "./cron.ts";

const at = (iso: string): Date => new Date(iso);

describe("cron", () => {
	test("daily at 08:00", () => {
		const cron = parseCron("0 8 * * *");
		expect(nextRun(cron, at("2026-10-10T07:59:30"))?.toString()).toBe(at("2026-10-10T08:00:00").toString());
		expect(nextRun(cron, at("2026-10-10T08:00:00"))?.toString()).toBe(at("2026-10-11T08:00:00").toString());
	});

	test("every 15 minutes", () => {
		const cron = parseCron("*/15 * * * *");
		expect(nextRun(cron, at("2026-10-10T10:07:00"))?.getMinutes()).toBe(15);
	});

	test("weekdays at 09:30, Sunday as 0 or 7", () => {
		const cron = parseCron("30 9 * * 1-5");
		// 2026-10-10 is a Saturday: the next run is Monday the 12th.
		expect(nextRun(cron, at("2026-10-10T12:00:00"))?.getDate()).toBe(12);
		expect(matches(parseCron("0 0 * * 7"), at("2026-10-11T00:00:00"))).toBe(true);
	});

	test("day-of-month and day-of-week both set: either matches", () => {
		const cron = parseCron("0 12 1 * 1");
		expect(matches(cron, at("2026-10-01T12:00:00"))).toBe(true); // the 1st (a Thursday)
		expect(matches(cron, at("2026-10-05T12:00:00"))).toBe(true); // a Monday
		expect(matches(cron, at("2026-10-06T12:00:00"))).toBe(false);
	});

	test("lists and ranges with steps", () => {
		const cron = parseCron("0 8-18/2,22 * * *");
		expect([...cron.hours].sort((a, b) => a - b)).toEqual([8, 10, 12, 14, 16, 18, 22]);
	});

	test("an impossible date answers null, quickly", () => {
		const started = Date.now();
		expect(nextRun(parseCron("0 0 31 2 *"), at("2026-10-10T12:00:00"))).toBeNull();
		expect(Date.now() - started).toBeLessThan(500);
	});

	test("rare schedules are found across month boundaries", () => {
		expect(nextRun(parseCron("0 9 1 1 *"), at("2026-10-10T12:00:00"))?.toString()).toBe(at("2027-01-01T09:00:00").toString());
	});

	test.each(["", "* * * *", "61 * * * *", "* 24 * * *", "*/0 * * * *", "5-1 * * * *", "a * * * *"])("rejects %j", (expression) => {
		expect(() => parseCron(expression)).toThrow();
	});
});
