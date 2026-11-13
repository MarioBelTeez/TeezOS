import { describe, expect, it } from "vitest";
import { extractAuthUrl, parseClaudeAuthStatus } from "./setup.ts";

describe("agent setup helpers", () => {
	it("extracts an https OAuth URL from CLI output", () => {
		expect(extractAuthUrl("Open https://claude.ai/oauth/authorize?code=123 in your browser.")).toBe(
			"https://claude.ai/oauth/authorize?code=123",
		);
		expect(extractAuthUrl("Visit (https://auth.openai.com/login), then continue")).toBe("https://auth.openai.com/login");
		expect(extractAuthUrl("no url here")).toBeNull();
	});

	it("parses claude auth status JSON", () => {
		expect(parseClaudeAuthStatus('{"loggedIn":true,"subscriptionType":"pro"}')).toEqual({
			loggedIn: true,
			detail: "pro",
		});
		expect(parseClaudeAuthStatus('{"loggedIn":false}')).toEqual({ loggedIn: false });
		expect(parseClaudeAuthStatus("not json")).toEqual({ loggedIn: false });
	});
});
