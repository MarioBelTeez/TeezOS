import { HttpError, readJsonBody, type Route } from "../http.ts";
import type { PushService, PushSubscriptionJSON } from "../push.ts";

const KEY_PATH = "/api/push/key";
const SUBSCRIBE_PATH = "/api/push/subscribe";
const NOT_SET_UP = "Push is not set up yet.";
const MAX_FIELD_CHARS = 2048;

export type PushRouteDeps = {
	/** Null when `vapid.json` is missing: every push route then answers 503. */
	readonly push: Pick<PushService, "subscribe" | "unsubscribe"> | null;
	readonly publicKey: string;
};

const record = (body: unknown): Record<string, unknown> => (typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {});

function shortText(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_CHARS ? value : null;
}

/** A browser push subscription: an https endpoint and its two keys. */
function parseSubscription(body: unknown): PushSubscriptionJSON {
	const endpoint = shortText(record(body)["endpoint"]);
	const keys = record(record(body)["keys"]);
	const p256dh = shortText(keys["p256dh"]);
	const auth = shortText(keys["auth"]);
	if (!endpoint || !endpoint.startsWith("https://") || !p256dh || !auth) throw new HttpError(400, "invalid subscription");
	return { endpoint, keys: { p256dh, auth } };
}

export function createPushRoute(deps: PushRouteDeps): Route {
	return async (req, url) => {
		if (url.pathname !== KEY_PATH && url.pathname !== SUBSCRIBE_PATH) return null;
		if (!deps.push) return { status: 503, body: { error: NOT_SET_UP } };
		if (url.pathname === KEY_PATH) {
			return req.method === "GET" ? { status: 200, body: { publicKey: deps.publicKey } } : { status: 405, body: { error: "method not allowed" } };
		}
		if (req.method === "POST") {
			deps.push.subscribe(parseSubscription(await readJsonBody(req)));
			return { status: 200, body: { ok: true } };
		}
		if (req.method === "DELETE") {
			const endpoint = shortText(record(await readJsonBody(req))["endpoint"]);
			if (!endpoint) throw new HttpError(400, "endpoint is required");
			deps.push.unsubscribe(endpoint);
			return { status: 200, body: { ok: true } };
		}
		return { status: 405, body: { error: "method not allowed" } };
	};
}
