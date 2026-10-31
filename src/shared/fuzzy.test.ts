import { describe, expect, test } from "vitest";
import { fuzzyScore } from "./fuzzy.ts";

describe("fuzzyScore", () => {
	const rank = (query: string, paths: string[]) =>
		paths
			.map((p) => ({ p, s: fuzzyScore(query, p) }))
			.filter((x) => x.s !== null)
			.sort((a, b) => (b.s ?? 0) - (a.s ?? 0))
			.map((x) => x.p);

	test("characters must appear in order", () => {
		expect(fuzzyScore("xyz", "src/index.ts")).toBeNull();
		expect(fuzzyScore("sit", "src/index.ts")).not.toBeNull();
	});

	test("file-name matches beat folder matches", () => {
		expect(rank("chat", ["src/chat/reduce.ts", "src/renderer/ChatPanel.tsx"])[0]).toBe("src/renderer/ChatPanel.tsx");
	});

	test("a shorter path wins a tie", () => {
		expect(rank("index", ["a/b/c/index.ts", "index.ts"])[0]).toBe("index.ts");
	});

	test("camelCase humps count as word starts", () => {
		expect(rank("cp", ["src/compute.ts", "src/renderer/ChatPanel.tsx"])[0]).toBe("src/renderer/ChatPanel.tsx");
	});
});
