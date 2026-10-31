import { describe, expect, test } from "vitest";
import { safeMarkdownUrl } from "./safe-url.ts";

describe("safeMarkdownUrl", () => {
	test.each([
		["https://example.com/a", "href", "https://example.com/a"],
		["http://example.com/a", "href", "http://example.com/a"],
		["mailto:info@example.com", "href", "mailto:info@example.com"],
		["#section", "href", "#section"],
		["docs/setup.md", "href", "docs/setup.md"],
		["https://example.com/x.png", "src", "https://example.com/x.png"],
		["data:image/png;base64,AAAA", "src", "data:image/png;base64,AAAA"],
	])("keeps %s as %s", (url, key, expected) => {
		expect(safeMarkdownUrl(url, key)).toBe(expected);
	});

	test.each([
		// Against a file:// page these become \\host\share: Windows would try SMB and send an NTLM hash.
		["//attacker.example/s/x.png", "src"],
		["//attacker.example/s", "href"],
		["\\\\attacker.example\\s\\x.png", "src"],
		["/\\attacker.example/x.png", "src"],
		["file://attacker.example/s/x.png", "src"],
		["file:///C:/Users/user/.ssh/id_ed25519", "href"],
		["javascript:alert(1)", "href"],
		["JaVaScRiPt:alert(1)", "href"],
		["data:text/html,<script>", "href"],
		["data:image/svg+xml,<svg onload=alert(1)>", "src"],
		// A relative image would load from the app's own folder on disk.
		["../../secret.png", "src"],
		["  //attacker.example/x.png", "src"],
	])("drops %s as %s", (url, key) => {
		expect(safeMarkdownUrl(url, key)).toBe("");
	});
});
