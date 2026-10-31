import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import webpush from "web-push";

export type PushSubscriptionJSON = {
	readonly endpoint: string;
	readonly keys: { readonly p256dh: string; readonly auth: string };
};
export type PushPayload = { readonly title: string; readonly body: string; readonly url: string; readonly tag: string };
export type VapidKeys = { readonly publicKey: string; readonly privateKey: string; readonly subject: string };

type Send = (subscription: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

export type PushDeps = {
	readonly file: string;
	readonly vapid: VapidKeys;
	readonly send?: Send;
};

/** A push service answering these has forgotten the subscription for good. */
const GONE_STATUSES = new Set([404, 410]);

function isSubscription(value: unknown): value is PushSubscriptionJSON {
	if (typeof value !== "object" || value === null) return false;
	const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
	return typeof sub.endpoint === "string" && typeof sub.keys?.p256dh === "string" && typeof sub.keys.auth === "string";
}

function readSubscriptions(file: string): PushSubscriptionJSON[] {
	if (!existsSync(file)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(parsed) ? parsed.filter(isSubscription).map((s) => ({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } })) : [];
	} catch {
		return [];
	}
}

/** Web Push to the phone: the subscriptions live in one JSON file, written atomically. */
export class PushService {
	readonly #file: string;
	readonly #vapid: VapidKeys;
	readonly #send: Send;
	#subscriptions: readonly PushSubscriptionJSON[];

	constructor(deps: PushDeps) {
		this.#file = deps.file;
		this.#vapid = deps.vapid;
		this.#send = deps.send ?? ((sub, payload, options) => webpush.sendNotification(sub, payload, options));
		this.#subscriptions = readSubscriptions(deps.file);
	}

	list(): readonly PushSubscriptionJSON[] {
		return this.#subscriptions;
	}

	/** Adds the subscription, or replaces the one with the same endpoint (keys can change). */
	subscribe(sub: PushSubscriptionJSON): void {
		const next = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
		const exists = this.#subscriptions.some((s) => s.endpoint === next.endpoint);
		this.#save(exists ? this.#subscriptions.map((s) => (s.endpoint === next.endpoint ? next : s)) : [...this.#subscriptions, next]);
	}

	unsubscribe(endpoint: string): void {
		if (!this.#subscriptions.some((s) => s.endpoint === endpoint)) return;
		this.#save(this.#subscriptions.filter((s) => s.endpoint !== endpoint));
	}

	/** Sends to every subscription; one that fails does not stop the rest, and gone ones (404/410) are dropped. */
	async notify(payload: PushPayload): Promise<void> {
		const body = JSON.stringify(payload);
		const results = await Promise.all(
			this.#subscriptions.map(async (sub) => {
				try {
					await this.#send(sub, body, { vapidDetails: this.#vapid, TTL: 3600 });
					return { sub, gone: false };
				} catch (error) {
					const status = (error as { statusCode?: unknown }).statusCode;
					if (typeof status === "number" && GONE_STATUSES.has(status)) return { sub, gone: true };
					console.error("phone: push failed", status ?? (error instanceof Error ? error.message : error));
					return { sub, gone: false };
				}
			}),
		);
		const gone = new Set(results.filter((r) => r.gone).map((r) => r.sub.endpoint));
		if (gone.size > 0) this.#save(this.#subscriptions.filter((s) => !gone.has(s.endpoint)));
	}

	#save(next: readonly PushSubscriptionJSON[]): void {
		mkdirSync(path.dirname(this.#file), { recursive: true });
		const tmp = `${this.#file}.tmp`;
		writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
		renameSync(tmp, this.#file);
		this.#subscriptions = next;
	}
}

/** The VAPID keys from `vapid.json`; null when the file is missing or incomplete. */
export function loadVapid(file: string, subject: string): VapidKeys | null {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { publicKey?: unknown; privateKey?: unknown };
		return typeof raw.publicKey === "string" && typeof raw.privateKey === "string" && raw.publicKey && raw.privateKey
			? { publicKey: raw.publicKey, privateKey: raw.privateKey, subject }
			: null;
	} catch {
		return null;
	}
}
