import { describe, expect, it } from "vitest";
import { authorize, phoneAllowed } from "./auth.ts";

const MAIN = "m".repeat(40);
const PHONE = "p".repeat(40);
const tokens = { main: MAIN, phone: PHONE };
const bearer = (token: string): string => `Bearer ${token}`;

describe("runner token scopes", () => {
	it("the phone token reads runs and starts a job but cannot create, edit or delete jobs or touch the Claude token", () => {
		const header = bearer(PHONE);
		const allowed: [string, string][] = [
			["GET", "/health"],
			["GET", "/jobs"],
			["GET", "/runs"],
			["GET", "/runs/abc"],
			["GET", "/runs/abc/events"],
			["POST", "/jobs/abc/run"],
			["POST", "/runs/abc/cancel"],
		];
		for (const [method, pathname] of allowed) expect(authorize(header, tokens, method, pathname), `${method} ${pathname}`).toBe("phone");
		const refused: [string, string][] = [
			["POST", "/jobs"],
			["PUT", "/jobs/abc"],
			["DELETE", "/jobs/abc"],
			["GET", "/jobs/abc"],
			["PUT", "/claude-token"],
			["DELETE", "/claude-token"],
			["GET", "/claude-token"],
			["POST", "/runs"],
			["DELETE", "/runs/abc"],
			["GET", "/jobs/abc/run"],
			["POST", "/jobs/abc/run/extra"],
		];
		for (const [method, pathname] of refused) expect(authorize(header, tokens, method, pathname), `${method} ${pathname}`).toBe("forbidden");
	});

	it("the main token keeps full access", () => {
		expect(authorize(bearer(MAIN), tokens, "PUT", "/claude-token")).toBe("full");
		expect(authorize(bearer(MAIN), tokens, "DELETE", "/jobs/abc")).toBe("full");
	});

	it("refuses a wrong or missing token, and ignores an absent phone token", () => {
		expect(authorize(bearer("x".repeat(40)), tokens, "GET", "/health")).toBe("unauthorized");
		expect(authorize("", tokens, "GET", "/health")).toBe("unauthorized");
		expect(authorize(bearer(PHONE), { main: MAIN, phone: null }, "GET", "/health")).toBe("unauthorized");
		expect(authorize(bearer(MAIN), { main: MAIN, phone: null }, "GET", "/health")).toBe("full");
	});

	it("phoneAllowed matches exactly the seven routes", () => {
		expect(phoneAllowed("GET", "/runs/")).toBe(true);
		expect(phoneAllowed("GET", "/runs/a/b/c")).toBe(false);
	});
});
