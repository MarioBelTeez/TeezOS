import { describe, expect, test } from "vitest";
import { keyBytes, withTimeout } from "./push.ts";

describe("keyBytes", () => {
	test("reads a URL-safe base64 VAPID key without padding", () => {
		// 0xfb 0xff 0xfe is "+//+" in plain base64 and "-__-" URL-safe.
		expect([...keyBytes("-__-")]).toEqual([0xfb, 0xff, 0xfe]);
		expect([...keyBytes("AQI")]).toEqual([1, 2]);
	});
});

describe("withTimeout", () => {
	test("passes a result through in time and fails with the message when it is late", async () => {
		await expect(withTimeout(Promise.resolve(7), 50, "late")).resolves.toBe(7);
		await expect(withTimeout(new Promise(() => undefined), 10, "The service worker is not ready.")).rejects.toThrow("The service worker is not ready.");
	});
});
