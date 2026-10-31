import { describe, expect, test } from "vitest";
import { feedBody, feedBusy } from "./feed-input.ts";

describe("feedBody", () => {
	test("sends a link as url and anything else as text", () => {
		expect(feedBody("  https://youtu.be/abc  ", "auto")).toEqual({ url: "https://youtu.be/abc", kind: "auto" });
		expect(feedBody("a thought worth filing", "source")).toEqual({ text: "a thought worth filing", kind: "source" });
		expect(feedBody("see https://x.y for more", "auto")).toEqual({ text: "see https://x.y for more", kind: "auto" });
	});
});

describe("feedBusy", () => {
	test("is busy only while an item is queued or being worked on", () => {
		expect(feedBusy([{ status: "done" }, { status: "failed" }, { status: "cancelled" }])).toBe(false);
		expect(feedBusy([{ status: "done" }, { status: "queued" }])).toBe(true);
		expect(feedBusy([{ status: "reading" }])).toBe(true);
		expect(feedBusy([{ status: "writing" }])).toBe(true);
		expect(feedBusy([])).toBe(false);
	});
});
