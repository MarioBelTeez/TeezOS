import { describe, expect, test } from "vitest";
import { textSizeForKey } from "./text-size.ts";

describe("textSizeForKey", () => {
	test("Ctrl+= steps up and stops at large", () => {
		expect(textSizeForKey("s", "=")).toBe("m");
		expect(textSizeForKey("m", "+")).toBe("l");
		expect(textSizeForKey("l", "=")).toBe("l");
	});

	test("Ctrl+- steps down and stops at small", () => {
		expect(textSizeForKey("l", "-")).toBe("m");
		expect(textSizeForKey("m", "-")).toBe("s");
		expect(textSizeForKey("s", "-")).toBe("s");
	});

	test("Ctrl+0 resets to medium", () => {
		expect(textSizeForKey("l", "0")).toBe("m");
	});

	test("other keys are not ours", () => {
		expect(textSizeForKey("m", "k")).toBeNull();
	});
});
