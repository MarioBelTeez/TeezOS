/**
 * Five-field cron ("m h dom mon dow"), the subset everyone writes: `*`, `*\/n`,
 * `a-b`, `a-b/n` and comma lists. Day 0 and 7 are Sunday. When both day of
 * month and day of week are restricted, either may match — as in Vixie cron.
 * Times are local to the runner (its TZ).
 */

export type Cron = {
	readonly minutes: ReadonlySet<number>;
	readonly hours: ReadonlySet<number>;
	readonly days: ReadonlySet<number>;
	readonly months: ReadonlySet<number>;
	readonly weekdays: ReadonlySet<number>;
	readonly dayRestricted: boolean;
	readonly weekdayRestricted: boolean;
};

function field(text: string, min: number, max: number): Set<number> {
	const values = new Set<number>();
	for (const part of text.split(",")) {
		const [rangePart = "", stepPart] = part.split("/");
		const step = stepPart === undefined ? 1 : Number(stepPart);
		if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${part}"`);
		let from: number;
		let to: number;
		if (rangePart === "*") {
			from = min;
			to = max;
		} else if (rangePart.includes("-")) {
			const [a, b] = rangePart.split("-").map(Number);
			from = a ?? NaN;
			to = b ?? NaN;
		} else {
			from = Number(rangePart);
			to = stepPart === undefined ? from : max;
		}
		if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
			throw new Error(`"${part}" is out of range ${min}-${max}`);
		}
		for (let v = from; v <= to; v += step) values.add(v);
	}
	return values;
}

export function parseCron(expression: string): Cron {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error("A schedule needs five fields: minute hour day-of-month month day-of-week");
	const [m = "", h = "", dom = "", mon = "", dow = ""] = parts;
	const weekdays = field(dow, 0, 7);
	if (weekdays.has(7)) weekdays.add(0);
	return {
		minutes: field(m, 0, 59),
		hours: field(h, 0, 23),
		days: field(dom, 1, 31),
		months: field(mon, 1, 12),
		weekdays,
		dayRestricted: dom !== "*",
		weekdayRestricted: dow !== "*",
	};
}

export function matches(cron: Cron, date: Date): boolean {
	if (!cron.minutes.has(date.getMinutes()) || !cron.hours.has(date.getHours()) || !cron.months.has(date.getMonth() + 1)) return false;
	return dayMatches(cron, date);
}

function dayMatches(cron: Cron, date: Date): boolean {
	const dayOk = cron.days.has(date.getDate());
	const weekdayOk = cron.weekdays.has(date.getDay());
	if (cron.dayRestricted && cron.weekdayRestricted) return dayOk || weekdayOk;
	if (cron.dayRestricted) return dayOk;
	if (cron.weekdayRestricted) return weekdayOk;
	return true;
}

/**
 * The first minute strictly after `from` that matches, or null within five
 * years (an impossible date like 31 February). Whole months, days and hours
 * that cannot match are skipped, so this is quick even for rare schedules.
 */
export function nextRun(cron: Cron, from: Date): Date | null {
	const date = new Date(from.getTime());
	date.setSeconds(0, 0);
	date.setMinutes(date.getMinutes() + 1);
	const limit = from.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;
	while (date.getTime() <= limit) {
		if (!cron.months.has(date.getMonth() + 1)) {
			date.setMonth(date.getMonth() + 1, 1);
			date.setHours(0, 0, 0, 0);
			continue;
		}
		if (!dayMatches(cron, date)) {
			date.setDate(date.getDate() + 1);
			date.setHours(0, 0, 0, 0);
			continue;
		}
		if (!cron.hours.has(date.getHours())) {
			date.setHours(date.getHours() + 1, 0, 0, 0);
			continue;
		}
		if (cron.minutes.has(date.getMinutes())) return date;
		date.setMinutes(date.getMinutes() + 1);
	}
	return null;
}
