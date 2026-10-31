import { describe, expect, test } from "vitest";
import { parseRoute, pathFor } from "./route.ts";

describe("route", () => {
	test("opens on the chat", () => {
		expect(parseRoute("/")).toEqual({ tab: "chat", id: null });
		expect(parseRoute("/nonsense")).toEqual({ tab: "chat", id: null });
	});

	test("reads the paths notifications open", () => {
		expect(parseRoute("/chat/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed")).toEqual({ tab: "chat", id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" });
		expect(parseRoute("/server")).toEqual({ tab: "server", id: null });
		expect(parseRoute("/runs/r_12-a")).toEqual({ tab: "runs", id: "r_12-a" });
		expect(parseRoute("/feed")).toEqual({ tab: "feed", id: null });
	});

	test("drops ids that are not plain", () => {
		expect(parseRoute("/runs/..%2Fx")).toEqual({ tab: "runs", id: null });
	});

	test("writes paths back", () => {
		expect(pathFor({ tab: "chat", id: null })).toBe("/");
		expect(pathFor({ tab: "chat", id: "abc" })).toBe("/chat/abc");
		expect(pathFor({ tab: "runs", id: "r1" })).toBe("/runs/r1");
		expect(pathFor({ tab: "server", id: null })).toBe("/server");
	});
});
