/**
 * electron-updater's errors are long and wrap the real cause ("Unable to find
 * latest version on GitHub … please ensure a production release exists:
 * Error: net::ERR_NETWORK_IO_SUSPENDED …" just means the PC went to sleep).
 * Turn them into a short line, and say whether trying again soon makes sense.
 */

const SLEEP = /ERR_NETWORK_IO_SUSPENDED/;
const OFFLINE = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_\w+|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/;
const REFUSED = /\b(401|403)\b|Bad credentials/i;
const MAX_MESSAGE = 200;

export function explainUpdateError(raw: string): { message: string; retryable: boolean } {
	if (SLEEP.test(raw)) return { message: "the PC went to sleep during the check", retryable: true };
	if (OFFLINE.test(raw)) return { message: "couldn't reach GitHub (offline?)", retryable: true };
	if (REFUSED.test(raw)) return { message: "GitHub refused the token: replace it below", retryable: false };
	const firstLine = raw.split("\n")[0]?.trim() || "unknown error";
	return { message: firstLine.length > MAX_MESSAGE ? `${firstLine.slice(0, MAX_MESSAGE - 1)}…` : firstLine, retryable: false };
}

/** Wait before retry number `attempt` (0-based): 1, 2, 4 … minutes, at most 30. */
export function retryDelayMs(attempt: number): number {
	return Math.min(60_000 * 2 ** attempt, 30 * 60_000);
}
