import { timingSafeEqual } from "node:crypto";

/** What a request may do: everything, the phone's narrow set, or nothing. */
export type AuthDecision = "full" | "phone" | "forbidden" | "unauthorized";

export type Tokens = { readonly main: string; readonly phone: string | null };

const safeEqual = (given: string, expected: string): boolean => {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The phone may list jobs and runs, run a job now and cancel a run, and nothing
 * else: no creating, editing or deleting jobs, and no Claude token.
 */
export function phoneAllowed(method: string, pathname: string): boolean {
	const parts = pathname.split("/").filter(Boolean);
	const [first, , third] = parts;
	if (method === "GET") {
		if (first === "health") return parts.length === 1;
		if (first === "jobs") return parts.length === 1;
		if (first === "runs") return parts.length === 1 || parts.length === 2 || (parts.length === 3 && third === "events");
		return false;
	}
	if (method === "POST") {
		if (first === "jobs") return parts.length === 3 && third === "run";
		if (first === "runs") return parts.length === 3 && third === "cancel";
	}
	return false;
}

/** Checks the bearer header against both tokens (timing-safe) and, for the phone token, the route. */
export function authorize(header: string, tokens: Tokens, method: string, pathname: string): AuthDecision {
	const given = header.startsWith("Bearer ") ? header.slice(7) : "";
	// Compare against both so the answer time does not say which token was close.
	const isMain = safeEqual(given, tokens.main);
	const isPhone = tokens.phone !== null && safeEqual(given, tokens.phone);
	if (isMain) return "full";
	if (isPhone) return phoneAllowed(method, pathname) ? "phone" : "forbidden";
	return "unauthorized";
}
