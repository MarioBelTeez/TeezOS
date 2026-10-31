import { describe, expect, test } from "vitest";
import { parseModels, resolveAgy } from "./locate.ts";

describe("resolveAgy", () => {
	test("finds the installer's folder before PATH on Windows", () => {
		const found = resolveAgy({
			platform: "win32",
			env: { LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local" },
			home: "C:\\Users\\user",
			pathEntries: ["C:\\tools"],
			isFile: (file) => file === "C:\\Users\\user\\AppData\\Local\\agy\\bin\\agy.exe" || file === "C:\\tools\\agy.exe",
		});
		expect(found).toBe("C:\\Users\\user\\AppData\\Local\\agy\\bin\\agy.exe");
	});

	test("an override wins, and nothing found is null", () => {
		expect(
			resolveAgy({ platform: "linux", env: { TEEZAI_AGY_PATH: "/opt/agy" }, home: "/home/r", pathEntries: [], isFile: (f) => f === "/opt/agy" }),
		).toBe("/opt/agy");
		expect(resolveAgy({ platform: "linux", env: {}, home: "/home/r", pathEntries: ["/usr/bin"], isFile: () => false })).toBeNull();
	});
});

describe("parseModels", () => {
	test("reads id and label, skipping the banner", () => {
		const output = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
		expect(parseModels(output)).toEqual([
			{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
			{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
		]);
	});
});
