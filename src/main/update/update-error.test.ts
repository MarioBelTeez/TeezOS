import { describe, expect, test } from "vitest";
import { explainUpdateError, retryDelayMs } from "./update-error.ts";

const SLEEP =
	"Unable to find latest version on GitHub (https://api.github.com/repos/MarioBelTeez/TeezAI/releases/latest), please ensure a production release exists: Error: net::ERR_NETWORK_IO_SUSPENDED at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:1:136948)";

describe("explainUpdateError", () => {
	test("the PC going to sleep mid-check is a short, retryable note", () => {
		expect(explainUpdateError(SLEEP)).toEqual({ message: "the PC went to sleep during the check", retryable: true });
	});

	test("being offline is retryable", () => {
		for (const code of ["net::ERR_INTERNET_DISCONNECTED", "net::ERR_NAME_NOT_RESOLVED", "net::ERR_NETWORK_CHANGED", "net::ERR_CONNECTION_RESET", "net::ERR_TIMED_OUT", "getaddrinfo ENOTFOUND api.github.com", "connect ETIMEDOUT"]) {
			expect(explainUpdateError(`Unable to find latest version on GitHub: Error: ${code}`), code).toEqual({ message: "couldn't reach GitHub (offline?)", retryable: true });
		}
	});

	test("a refused token says what to do and is not retried", () => {
		expect(explainUpdateError('HttpError: 401 Unauthorized "Bad credentials"')).toEqual({ message: "GitHub refused the token: replace it below", retryable: false });
		expect(explainUpdateError("HttpError: 403 Forbidden")).toEqual({ message: "GitHub refused the token: replace it below", retryable: false });
	});

	test("anything else keeps its first line, shortened", () => {
		const result = explainUpdateError(`Something odd happened\n${"x".repeat(500)}`);
		expect(result).toEqual({ message: "Something odd happened", retryable: false });
		expect(explainUpdateError("y".repeat(400)).message.length).toBeLessThanOrEqual(200);
	});
});

describe("retryDelayMs", () => {
	test("one minute, then longer, capped at 30 minutes", () => {
		expect(retryDelayMs(0)).toBe(60_000);
		expect(retryDelayMs(1)).toBe(120_000);
		expect(retryDelayMs(2)).toBe(240_000);
		expect(retryDelayMs(10)).toBe(30 * 60_000);
	});
});
