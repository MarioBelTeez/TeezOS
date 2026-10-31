import { describe, expect, test } from "vitest";
import { nearBottom } from "./scroll.ts";

describe("nearBottom", () => {
	test("is true within 80 px of the end and false further up", () => {
		expect(nearBottom({ scrollTop: 920, clientHeight: 600, scrollHeight: 1600 })).toBe(true);
		expect(nearBottom({ scrollTop: 1000, clientHeight: 600, scrollHeight: 1600 })).toBe(true);
		expect(nearBottom({ scrollTop: 900, clientHeight: 600, scrollHeight: 1600 })).toBe(false);
		expect(nearBottom({ scrollTop: 0, clientHeight: 600, scrollHeight: 400 })).toBe(true);
	});
});
