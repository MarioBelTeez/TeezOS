import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./math.ts";

describe("normalizeMathDelimiters", () => {
	it("converts inline \\(...\\) and block \\[...\\] delimiters", () => {
		expect(normalizeMathDelimiters("Force is \\(F = m a\\) in N.")).toBe("Force is $F = m a$ in N.");
		expect(normalizeMathDelimiters("Formula:\n\\[\nE = mc^2\n\\]")).toBe("Formula:\n$$\nE = mc^2\n$$");
	});

	it("leaves fenced code blocks and inline code untouched", () => {
		const source = "Use `\\(x\\)` or:\n```tex\n\\[y = x\\]\n```\nAnd \\(z = 1\\).";
		expect(normalizeMathDelimiters(source)).toBe("Use `\\(x\\)` or:\n```tex\n\\[y = x\\]\n```\nAnd $z = 1$.");
	});
});
