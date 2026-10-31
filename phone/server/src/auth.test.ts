import { describe, expect, it } from "vitest";
import { isAllowed } from "./auth.ts";

const LOGIN = "owner@github";

describe("isAllowed", () => {
	it("refuses a request without the Tailscale login header", () => {
		expect(isAllowed({}, LOGIN)).toBe(false);
	});
	it("refuses another tailnet user", () => {
		expect(isAllowed({ "tailscale-user-login": "someone@github" }, LOGIN)).toBe(false);
	});
	it("accepts owner@github in any case", () => {
		expect(isAllowed({ "tailscale-user-login": "OWNER@GITHUB" }, LOGIN)).toBe(true);
		expect(isAllowed({ "tailscale-user-login": LOGIN }, LOGIN)).toBe(true);
	});
	it("refuses a repeated header", () => {
		expect(isAllowed({ "tailscale-user-login": [LOGIN, LOGIN] }, LOGIN)).toBe(false);
	});
});
