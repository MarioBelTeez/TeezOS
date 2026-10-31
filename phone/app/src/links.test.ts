import { describe, expect, test } from "vitest";
import { safeHref } from "./links.ts";

describe("safeHref", () => {
	test("lets http(s) and mailto links through", () => {
		expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
		expect(safeHref("http://example.com")).toBe("http://example.com/");
		expect(safeHref("mailto:user@example.com")).toBe("mailto:user@example.com");
	});

	test("refuses every other kind of link", () => {
		expect(safeHref("javascript:alert(1)")).toBeNull();
		expect(safeHref("data:text/html,hi")).toBeNull();
		expect(safeHref("obsidian://open?vault=x")).toBeNull();
		expect(safeHref("/relative")).toBeNull();
		expect(safeHref(undefined)).toBeNull();
	});
});
