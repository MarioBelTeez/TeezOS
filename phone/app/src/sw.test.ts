import { describe, expect, test } from "vitest";
import { notificationFor, urlForClick } from "./sw-logic.ts";

describe("urlForClick", () => {
	test("opens only same-origin paths from a notification", () => {
		expect(urlForClick({ url: "/chat/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" })).toBe("/chat/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
		expect(urlForClick({ url: "/runs/r-12?x=1#end" })).toBe("/runs/r-12?x=1#end");
		expect(urlForClick({ url: "https://evil.example/phish" })).toBe("/");
		expect(urlForClick({ url: "//evil.example/phish" })).toBe("/");
		expect(urlForClick({ url: "/\\evil.example" })).toBe("/");
		expect(urlForClick({ url: "javascript:alert(1)" })).toBe("/");
		expect(urlForClick({ url: "server" })).toBe("/");
		expect(urlForClick({ url: "/\t/evil.example" })).toBe("/");
		expect(urlForClick({ url: 42 })).toBe("/");
		expect(urlForClick(null)).toBe("/");
		expect(urlForClick("/server")).toBe("/");
	});
});

describe("notificationFor", () => {
	test("turns the server's payload into a notification that remembers where to go", () => {
		const shown = notificationFor({ title: "Backup failed", body: "vzdump 101 ended with an error", url: "/server", tag: "server-backup" });
		expect(shown).not.toBeNull();
		expect(shown?.title).toBe("Backup failed");
		expect(shown?.options.body).toBe("vzdump 101 ended with an error");
		expect(shown?.options.tag).toBe("server-backup");
		expect(shown?.options.data).toEqual({ url: "/server" });
	});

	test("refuses a payload without a title", () => {
		expect(notificationFor(null)).toBeNull();
		expect(notificationFor("hello")).toBeNull();
		expect(notificationFor({ body: "no title" })).toBeNull();
		expect(notificationFor({ title: "" })).toBeNull();
	});

	test("never carries a foreign url into the click", () => {
		const shown = notificationFor({ title: "Hi", body: "", url: "https://evil.example", tag: "x" });
		expect(shown?.options.data).toEqual({ url: "/" });
	});
});
