import { describe, expect, test } from "vitest";
import { decidePermission } from "./permissions.ts";

describe("decidePermission", () => {
	const none = new Map<string, Set<string>>();
	test("harmless ones allowed, sensitive ones asked, the rest denied", () => {
		expect(decidePermission("clipboard-sanitized-write", "https://a.com", none)).toBe("allow");
		// Full screen hides the app and its address bar, so a page could pose as anything: asked.
		expect(decidePermission("fullscreen", "https://a.com", none)).toBe("ask");
		expect(decidePermission("media", "https://a.com", none)).toBe("ask");
		expect(decidePermission("notifications", "https://a.com", none)).toBe("ask");
		expect(decidePermission("openExternal", "https://a.com", none)).toBe("deny");
	});
	test("a grant is per origin", () => {
		const grants = new Map([["https://meet.com", new Set(["media"])]]);
		expect(decidePermission("media", "https://meet.com", grants)).toBe("allow");
		expect(decidePermission("media", "https://evil.com", grants)).toBe("ask");
	});
});
