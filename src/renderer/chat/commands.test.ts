import { describe, expect, test } from "vitest";
import { filterCommands, mergeCommands, teezCommand } from "./commands.ts";

const cli = [
	{ name: "compact", description: "Compact the conversation", argumentHint: "" },
	{ name: "clear", description: "CLI clear", argumentHint: "" },
	{ name: "om-standup", description: "Morning kickoff", argumentHint: "" },
];

describe("mergeCommands", () => {
	test("TeezAI's own come first and override the CLI's", () => {
		const items = mergeCommands(cli, "claude");
		expect(items.slice(0, 8).map((i) => i.name)).toEqual(["btw", "clear", "context", "cost", "effort", "mode", "model", "resume"]);
		expect(items.find((i) => i.name === "clear")?.action).toBe("clear");
	});
	test("other CLI commands are inserted as text", () => {
		const items = mergeCommands(cli, "claude");
		expect(items.find((i) => i.name === "om-standup")).toEqual({ name: "om-standup", description: "Morning kickoff", action: "insert" });
		expect(items.find((i) => i.name === "compact")?.action).toBe("insert");
	});
	test("Antigravity gets only what applies", () => {
		expect(mergeCommands(cli, "agy").map((i) => i.name)).toEqual(["btw", "clear", "effort", "mode", "model"]);
	});
	test("CLI commands after TeezAI's are sorted by name and keep their argument hint", () => {
		const items = mergeCommands([{ name: "review", description: "Review a PR", argumentHint: "<pr>" }, ...cli], "claude");
		expect(items.slice(8).map((i) => i.name)).toEqual(["compact", "om-standup", "review"]);
		expect(items.find((i) => i.name === "review")?.argumentHint).toBe("<pr>");
	});
});

describe("filterCommands", () => {
	const items = mergeCommands(cli, "claude");
	test("an empty query keeps the order", () => {
		expect(filterCommands(items, "")).toBe(items);
	});
	test("fuzzy matches the name, best first", () => {
		const names = filterCommands(items, "stand").map((i) => i.name);
		expect(names[0]).toBe("om-standup");
		expect(names).not.toContain("btw");
	});
	test("a query that matches nothing finds nothing", () => {
		expect(filterCommands(items, "zzzz")).toEqual([]);
	});
});

describe("teezCommand", () => {
	test("finds a typed TeezAI command and its argument", () => {
		expect(teezCommand("/btw what is this?", "claude")).toEqual({ action: "btw", argument: "what is this?" });
		expect(teezCommand("  /clear  ", "agy")).toEqual({ action: "clear", argument: "" });
		expect(teezCommand("/effort", "agy")).toEqual({ action: "effort", argument: "" });
	});
	test("leaves CLI commands, Claude-only ones in Antigravity, and plain text alone", () => {
		expect(teezCommand("/compact", "claude")).toBeNull();
		expect(teezCommand("/context", "agy")).toBeNull();
		expect(teezCommand("hello /clear", "claude")).toBeNull();
	});
});
