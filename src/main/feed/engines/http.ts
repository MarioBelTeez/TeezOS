import type { FetchFn } from "../net.ts";

/**
 * The one way the feed talks to a model API: https to a fixed host, a
 * timeout, no redirects, a capped response, and the key taken out of every
 * message that could reach the window, the log or feed.json.
 */

export type FailKind = "quota" | "auth" | "network" | "invalid" | "other";
export type Failure = { readonly ok: false; readonly kind: FailKind; readonly error: string };
export type Reply = { readonly ok: true; readonly status: number; readonly body: string; readonly headers: Headers };

export type ApiOptions = {
	/** The only host the request may go to. */
	readonly host: string;
	readonly timeoutMs: number;
	readonly maxBytes: number;
	readonly signal?: AbortSignal | undefined;
	/** Removed from any message built from the response or an error. */
	readonly secret: string;
};

export const fail = (kind: FailKind, error: string): Failure => ({ ok: false, kind, error });

/** `text` with every occurrence of the secret hidden. */
export function scrub(text: string, secret: string): string {
	return secret.length >= 8 ? text.split(secret).join("[key hidden]") : text;
}

/** The body of a response, read up to `max` bytes; null when it is longer. */
async function readCapped(response: Response, max: number): Promise<string | null> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) {
		await response.body?.cancel().catch(() => undefined);
		return null;
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export async function apiRequest(fetchFn: FetchFn, url: string, init: RequestInit, options: ApiOptions): Promise<Reply | Failure> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return fail("other", "The request address was not valid.");
	}
	if (target.protocol !== "https:" || target.hostname !== options.host || target.username || target.password) {
		return fail("other", `Requests go only to https://${options.host}.`);
	}
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	try {
		const response = await fetchFn(target.href, { ...init, redirect: "error", signal });
		const body = await readCapped(response, options.maxBytes);
		if (body === null) return fail("other", "The answer was larger than expected and was dropped.");
		return { ok: true, status: response.status, body, headers: response.headers };
	} catch (error) {
		if (options.signal?.aborted) return fail("other", "Cancelled.");
		if (timeout.aborted) return fail("network", `${options.host} did not answer within ${Math.round(options.timeoutMs / 1000)} seconds.`);
		const message = error instanceof Error ? error.message : String(error);
		return fail("network", `Could not reach ${options.host}: ${scrub(message, options.secret)}`);
	}
}

/** The `error.message` of a JSON error body, one line, or "". */
export function apiMessage(body: string, secret: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		const error = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["error"] : undefined;
		const message = typeof error === "object" && error !== null ? (error as Record<string, unknown>)["message"] : typeof error === "string" ? error : undefined;
		return typeof message === "string" ? scrub(message, secret).replace(/\s+/g, " ").trim().slice(0, 300) : "";
	} catch {
		return "";
	}
}

/** A clear failure for an HTTP error status of an engine. */
export function statusFailure(engine: string, model: string, reply: Reply, secret: string): Failure {
	const detail = apiMessage(reply.body, secret);
	const more = detail ? ` (${detail})` : "";
	const { status } = reply;
	const keyRejected = /api[ _]?key (not valid|invalid)|API_KEY_INVALID|invalid api key/i.test(reply.body);
	if (status === 401 || status === 403 || keyRejected) return fail("auth", `${engine} rejected the key${more}. Check it in Settings, Feed.`);
	if (status === 429) {
		const wait = reply.headers.get("retry-after");
		const when = wait && /^\d{1,6}$/.test(wait) ? ` Try again in ${wait} seconds.` : "";
		return fail("quota", `${engine} quota or rate limit reached${more}.${when} Retry later, or pick another engine in Settings, Feed.`);
	}
	if (status === 404) return fail("invalid", `${engine} does not know the model ${model}${more}. Pick another model in Settings, Feed.`);
	if (status === 413) return fail("invalid", `The source is too large for ${model}${more}.`);
	if (status === 400) return fail("invalid", `${engine} refused the request${more}.`);
	if (status >= 500) return fail("other", `${engine} is not available right now (${status})${more}. Retry in a moment.`);
	return fail("other", `${engine} answered ${status}${more}.`);
}

export const isFailure = (value: Reply | Failure): value is Failure => !value.ok;
