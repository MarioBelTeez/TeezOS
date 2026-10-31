/**
 * Every call the app makes to its own server. Same origin only (the CSP
 * allows nothing else), and never throws: a failure comes back as a value
 * with the server's own message, or `offline` when the request never got an
 * answer (no tailnet, no signal), so screens can say which it was.
 */

/** `status` is the HTTP status of an answered failure (absent when offline or the body was unreadable). */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; offline: boolean; status?: number };

export const OFFLINE_MESSAGE = "Can't reach TeezOS. You may be offline or off the tailnet.";

async function errorOf(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json();
		const message = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
		if (typeof message === "string" && message.length > 0) return message;
	} catch {
		// Not JSON (a proxy's error page): the status is all there is to say.
	}
	return `The server answered ${response.status}.`;
}

export async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
	let response: Response;
	try {
		response = await fetch(path, { credentials: "same-origin", ...init });
	} catch {
		return { ok: false, error: OFFLINE_MESSAGE, offline: true };
	}
	if (!response.ok) return { ok: false, error: await errorOf(response), offline: false, status: response.status };
	try {
		return { ok: true, data: (await response.json()) as T };
	} catch {
		return { ok: false, error: "The server sent something the app could not read.", offline: false };
	}
}

export function postJson<T>(path: string, body: unknown, method: "POST" | "DELETE" = "POST"): Promise<ApiResult<T>> {
	return request<T>(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
