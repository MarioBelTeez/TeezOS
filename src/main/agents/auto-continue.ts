import type { UiEvent } from "../claude/events.ts";

/**
 * Carry on by itself once a plan limit resets.
 *
 * When a Claude turn ends because the plan limit was reached, the chat is
 * given a timer for the reset time plus a short grace; when it fires and the
 * chat is idle, `continue` is sent as if the user had typed it. Schedules live
 * in memory only: they do not survive an app restart.
 *
 * The decisions are pure (`detectLimitHit`, `scheduleDelay`); `AutoContinue`
 * holds the per-chat state and takes its clock, timers and sender as
 * dependencies so the main process owns the real ones.
 */

/** Wait this long past the reset before sending, so the window has really reopened. */
export const RESUME_GRACE_MS = 30_000;
/** No single wait is longer than this; if the limit is still on, the next hit schedules again. */
export const MAX_WAIT_MS = 6 * 3_600_000;
/** Without a reset time, try again this often (24 tries of 15 minutes cover a full 6-hour window). */
export const RETRY_MS = 15 * 60_000;
/** Sends per limit episode, so a limit that never lifts cannot loop forever. */
export const MAX_TRIES = 24;
/** A chat still working when its timer fires is looked at again after this. */
export const BUSY_RECHECK_MS = 60_000;

/** The message sent on the user's behalf. */
export const CONTINUE_TEXT = "continue";

export type LimitHit = { readonly resetsAt: number | null };

/** The CLI's own wording when the plan limit stops a turn; anchored so a sentence about rate limits in code talk never matches. */
const LIMIT_TEXT = /^\s*(you['’]ve hit your( usage| session| weekly| 5-hour)? limit|claude( ai)? usage limit reached|(5-hour|five-hour|weekly|session|usage) limit reached)/i;

const RESET_TEXT = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]{1,64})\))?/i;

function zoneParts(at: number, zone: string | null): { y: number; m: number; d: number; h: number; min: number } {
	const f = new Intl.DateTimeFormat("en-US", {
		...(zone ? { timeZone: zone } : {}),
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
	});
	const get = (type: string): number => Number(f.formatToParts(at).find((p) => p.type === type)?.value ?? 0);
	return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute") };
}

/** Wall-clock time in `zone` (null = this machine) as epoch ms. */
function wallToEpoch(y: number, m: number, d: number, h: number, min: number, zone: string | null): number {
	if (!zone) return new Date(y, m - 1, d, h, min).getTime();
	const asUtc = Date.UTC(y, m - 1, d, h, min);
	const offsetAt = (at: number): number => {
		const p = zoneParts(at, zone);
		return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(at / 60_000) * 60_000;
	};
	const first = asUtc - offsetAt(asUtc);
	return asUtc - offsetAt(first);
}

/**
 * The reset time in the CLI's message, "resets 5am (Europe/Rome)": the next
 * occurrence of that wall time in that zone. An unknown or missing zone reads
 * as this machine's local time. Null when the message names no time.
 */
export function parseResetTime(text: string, now: number): number | null {
	const match = RESET_TEXT.exec(text);
	if (!match) return null;
	const hour12 = Number(match[1]);
	const minute = match[2] ? Number(match[2]) : 0;
	if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
	const hour = (hour12 % 12) + (match[3]?.toLowerCase() === "pm" ? 12 : 0);
	let zone: string | null = match[4]?.trim() ?? null;
	if (zone) {
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: zone });
		} catch {
			zone = null;
		}
	}
	const today = zoneParts(now, zone);
	let at = wallToEpoch(today.y, today.m, today.d, hour, minute, zone);
	if (at <= now) {
		const tomorrow = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
		at = wallToEpoch(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, minute, zone);
	}
	return at;
}

/** A rejected rate-limit event (reset time in seconds), or the limit message as an answer or an error; its own time is read when it has one. */
export function detectLimitHit(event: UiEvent, now: number = Date.now()): LimitHit | null {
	switch (event.kind) {
		case "rate-limit":
			if (event.status !== "rejected" || event.window === "overage") return null;
			return { resetsAt: event.resetsAt > 0 ? event.resetsAt * 1000 : null };
		case "turn-end":
			return LIMIT_TEXT.test(event.text) ? { resetsAt: parseResetTime(event.text, now) } : null;
		case "run-error":
			return LIMIT_TEXT.test(event.message) ? { resetsAt: parseResetTime(event.message, now) } : null;
		default:
			return null;
	}
}

/** Milliseconds to wait: until the reset plus the grace, capped at 6 hours; every 15 minutes when the reset is unknown. */
export function scheduleDelay(resetsAt: number | null, now: number): number {
	if (resetsAt === null) return RETRY_MS;
	return Math.min(MAX_WAIT_MS, Math.max(0, resetsAt + RESUME_GRACE_MS - now));
}

/** What the window is told about a chat's schedule. */
export type PauseChange =
	| { readonly kind: "waiting"; readonly chatId: string; readonly resumesAt: number; readonly estimated: boolean }
	| { readonly kind: "resumed"; readonly chatId: string }
	| { readonly kind: "cleared"; readonly chatId: string };

export type AutoContinueDeps = {
	readonly now: () => number;
	readonly setTimer: (fn: () => void, ms: number) => unknown;
	readonly clearTimer: (handle: unknown) => void;
	/** Send a message into the chat; false when the chat no longer exists. */
	readonly send: (chatId: string, text: string) => boolean;
	readonly enabled: () => boolean;
	readonly onChange: (change: PauseChange) => void;
};

type Entry = {
	readonly resetsAt: number | null;
	/** Continues already sent in this episode. */
	readonly tries: number;
	readonly timer: unknown;
};

export class AutoContinue {
	readonly #deps: AutoContinueDeps;
	readonly #entries = new Map<string, Entry>();
	/** The last reset time a rejected event gave, for the limit message that follows without one. */
	readonly #knownReset = new Map<string, number>();
	readonly #busy = new Set<string>();

	constructor(deps: AutoContinueDeps) {
		this.#deps = deps;
	}

	/** Every event of a Claude chat passes through here. */
	event(chatId: string, event: UiEvent): void {
		const hit = detectLimitHit(event, this.#deps.now());
		if (event.kind === "turn-end" || event.kind === "run-error" || event.kind === "turn-cancelled") this.#busy.delete(chatId);
		// Any sign of a turn under way, whoever started it, defers a timer that fires meanwhile.
		else if (event.kind === "text-delta" || event.kind === "text" || event.kind === "subagent-text" || event.kind === "tool-start") this.#busy.add(chatId);

		if (hit) {
			if (hit.resetsAt !== null) this.#knownReset.set(chatId, hit.resetsAt);
			this.#schedule(chatId, hit.resetsAt ?? this.#knownReset.get(chatId) ?? null);
			return;
		}
		if (event.kind === "turn-cancelled") {
			this.cancel(chatId);
		} else if (event.kind === "turn-end") {
			// An answer that is not the limit message: the episode is over.
			this.#knownReset.delete(chatId);
			this.#drop(chatId, true);
		}
	}

	/** The user sent a message: they have the wheel, and the chat is working. */
	userSent(chatId: string): void {
		this.#busy.add(chatId);
		this.cancel(chatId);
	}

	markBusy(chatId: string): void {
		this.#busy.add(chatId);
	}

	/** The banner's Cancel. */
	cancel(chatId: string): void {
		this.#knownReset.delete(chatId);
		this.#drop(chatId, true);
	}

	/** The chat is gone; nobody needs telling. */
	close(chatId: string): void {
		this.#knownReset.delete(chatId);
		this.#busy.delete(chatId);
		this.#drop(chatId, false);
	}

	/** The setting may have been switched off: nothing waits any longer. */
	settingsChanged(): void {
		if (this.#deps.enabled()) return;
		for (const chatId of [...this.#entries.keys()]) this.cancel(chatId);
	}

	disposeAll(): void {
		for (const chatId of [...this.#entries.keys()]) this.close(chatId);
	}

	#drop(chatId: string, notify: boolean): void {
		const entry = this.#entries.get(chatId);
		if (!entry) return;
		this.#deps.clearTimer(entry.timer);
		this.#entries.delete(chatId);
		if (notify) this.#deps.onChange({ kind: "cleared", chatId });
	}

	#schedule(chatId: string, resetsAt: number | null): void {
		if (!this.#deps.enabled()) return;
		const previous = this.#entries.get(chatId);
		const tries = previous?.tries ?? 0;
		if (previous) this.#deps.clearTimer(previous.timer);
		if (tries >= MAX_TRIES) {
			this.#entries.delete(chatId);
			this.#deps.onChange({ kind: "cleared", chatId });
			return;
		}
		const now = this.#deps.now();
		// A reset already past after a continue was sent is stale, not a reason to send again at once.
		const usable = resetsAt !== null && resetsAt <= now && tries > 0 ? null : resetsAt;
		const delay = scheduleDelay(usable, now);
		const timer = this.#deps.setTimer(() => this.#fire(chatId), delay);
		this.#entries.set(chatId, { resetsAt: usable, tries, timer });
		this.#deps.onChange({ kind: "waiting", chatId, resumesAt: now + delay, estimated: usable === null });
	}

	#fire(chatId: string): void {
		const entry = this.#entries.get(chatId);
		if (!entry) return;
		if (!this.#deps.enabled()) {
			this.cancel(chatId);
			return;
		}
		if (this.#busy.has(chatId)) {
			const timer = this.#deps.setTimer(() => this.#fire(chatId), BUSY_RECHECK_MS);
			this.#entries.set(chatId, { ...entry, timer });
			return;
		}
		// Kept, without a timer, so a limit hit by this very continue counts as another try.
		this.#knownReset.delete(chatId);
		this.#entries.set(chatId, { ...entry, tries: entry.tries + 1, timer: null });
		this.#busy.add(chatId);
		if (!this.#deps.send(chatId, CONTINUE_TEXT)) {
			this.close(chatId);
			return;
		}
		this.#deps.onChange({ kind: "resumed", chatId });
	}
}
