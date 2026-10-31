import { describe, expect, test } from "vitest";
import { isAllowedUrl, toUrl } from "./url.ts";

describe("toUrl", () => {
	test("full urls pass, hosts get https, words get searched", () => {
		expect(toUrl("https://privateemail.com")).toBe("https://privateemail.com");
		expect(toUrl("  example.com/contact ")).toBe("https://example.com/contact");
		expect(toUrl("localhost:5173")).toBe("https://localhost:5173");
		expect(toUrl("claude agent sdk")).toBe("https://duckduckgo.com/?q=claude%20agent%20sdk");
	});
	test("other schemes are searched, never loaded", () => {
		expect(toUrl("file:///C:/")).toBe("https://duckduckgo.com/?q=file%3A%2F%2F%2FC%3A%2F");
		expect(toUrl("javascript:alert(1)")).toBe("https://duckduckgo.com/?q=javascript%3Aalert(1)");
	});
	test("an explicit search engine is used for words", () => {
		expect(toUrl("a b", "https://search.example/?q=")).toBe("https://search.example/?q=a%20b");
	});
	test("about:blank stays itself", () => {
		expect(toUrl("about:blank")).toBe("about:blank");
	});
});
describe("isAllowedUrl", () => {
	test("only web pages", () => {
		expect(isAllowedUrl("https://a.com")).toBe(true);
		expect(isAllowedUrl("http://a.com")).toBe(true);
		expect(isAllowedUrl("about:blank")).toBe(true);
		for (const bad of ["file:///C:/Windows", "javascript:alert(1)", "obsidian://open", "ms-settings:", "chrome://gpu", "not a url"]) expect(isAllowedUrl(bad)).toBe(false);
	});
	test("about pages other than blank, and web urls without a host, are refused", () => {
		expect(isAllowedUrl("about:config")).toBe(false);
		expect(isAllowedUrl("about:blank#x")).toBe(false);
		expect(isAllowedUrl("https://")).toBe(false);
		expect(isAllowedUrl("HTTPS://A.COM/x")).toBe(true);
	});
});
