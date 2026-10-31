import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WRITE_RULES_SCRIPT, agyArgs, agyRules, keepKnownPath, parseAgyModels, probeAgy, uncheckedTools } from "./agy.ts";
import type { Job } from "./types.ts";

const job = (permission: Job["permission"], extra: Partial<Job> = {}): Job => ({ prompt: "Summarise", model: "", permission, ...extra }) as Job;

describe("agyArgs", () => {
	test("stream-json, prompt attached to -p so it is never read as a flag", () => {
		const args = agyArgs(job("read-only", { prompt: "--dangerously-skip-permissions do it" }));
		expect(args).toEqual(["--output-format", "stream-json", "-p=--dangerously-skip-permissions do it"]);
	});

	test("model is passed through; only full skips permissions", () => {
		expect(agyArgs(job("edit", { model: "gemini-3.8-flash-high" }))).toEqual(["--output-format", "stream-json", "--model=gemini-3.8-flash-high", "-p=Summarise"]);
		expect(agyArgs(job("full"))).toContain("--dangerously-skip-permissions");
		for (const level of ["read-only", "research", "edit"] as const) expect(agyArgs(job(level))).not.toContain("--dangerously-skip-permissions");
	});
});

describe("agyRules", () => {
	test("read-only: no writes, no web pages, no commands, no MCP", () => {
		const rules = agyRules("read-only");
		expect(rules.allow).toEqual([]);
		expect(rules.deny).toEqual(expect.arrayContaining(["write_file(*)", "read_url(*)", "execute_url(*)", "command(*)", "mcp(*)"]));
	});

	test("research: may read web pages, still no writes or commands", () => {
		const rules = agyRules("research");
		expect(rules.allow).toEqual(["read_url(*)"]);
		expect(rules.deny).toEqual(expect.arrayContaining(["write_file(*)", "command(*)", "mcp(*)"]));
		expect(rules.deny).not.toContain("read_url(*)");
	});

	test("edit: may write in its folder, no web pages or commands", () => {
		const rules = agyRules("edit");
		expect(rules.deny).not.toContain("write_file(*)");
		expect(rules.deny).toEqual(expect.arrayContaining(["read_url(*)", "command(*)", "mcp(*)"]));
	});

	test("full: no rules (the run skips permissions)", () => {
		expect(agyRules("full")).toEqual({ allow: [], deny: [] });
	});
});

describe("WRITE_RULES_SCRIPT", () => {
	const run = (home: string, rules: unknown): Record<string, unknown> => {
		execFileSync(process.execPath, ["-e", WRITE_RULES_SCRIPT, JSON.stringify(rules)], { env: { ...process.env, HOME: home, USERPROFILE: home } });
		return JSON.parse(readFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
	};

	test("replaces only the permissions, keeping every other setting", () => {
		const home = mkdtempSync(join(tmpdir(), "agy-home-"));
		try {
			mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
			writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), JSON.stringify({ theme: "dark", permissions: { allow: ["command(*)"], ask: ["x"] } }));
			expect(run(home, agyRules("read-only"))).toEqual({ theme: "dark", permissions: { allow: [], deny: [...agyRules("read-only").deny] } });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("creates the file when it is missing, and starts fresh when it is broken", () => {
		const home = mkdtempSync(join(tmpdir(), "agy-home-"));
		try {
			expect(run(home, { allow: [], deny: ["a"] })).toEqual({ permissions: { allow: [], deny: ["a"] } });
			writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "{not json");
			expect(run(home, { allow: ["b"], deny: [] })).toEqual({ permissions: { allow: ["b"], deny: [] } });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("parseAgyModels", () => {
	test("reads id and label per line, skipping the progress line", () => {
		const out = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\n";
		expect(parseAgyModels(out)).toEqual([
			{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
			{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
		]);
	});

	test("ignores ids a job could not store", () => {
		expect(parseAgyModels("bad id\tX\nok-1\tOK")).toEqual([{ id: "ok-1", label: "OK" }]);
	});
});

describe("probeAgy", () => {
	type Call = { file: string; args: readonly string[] };
	const fakeRun = (answers: Record<string, { ok: boolean; stdout: string }>, calls: Call[] = []) =>
		async (file: string, args: readonly string[]) => {
			calls.push({ file, args });
			return answers[[file, ...args].join(" ")] ?? { ok: false, stdout: "" };
		};

	test("finds agy through a login shell, then reads its version and models", async () => {
		const status = await probeAgy(
			fakeRun({
				"bash -lc command -v agy": { ok: true, stdout: "/home/agent/.local/bin/agy\n" },
				"/home/agent/.local/bin/agy --version": { ok: true, stdout: "1.3.6\n" },
				"/home/agent/.local/bin/agy models": { ok: true, stdout: "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n" },
			}),
		);
		expect(status).toEqual({
			path: "/home/agent/.local/bin/agy",
			installed: true,
			version: "1.3.6",
			loggedIn: true,
			models: [{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" }],
		});
	});

	test("not on the PATH: not installed, nothing else is run", async () => {
		const calls: Call[] = [];
		const status = await probeAgy(fakeRun({}, calls));
		expect(status).toEqual({ path: null, installed: false, version: "", loggedIn: false, models: [] });
		expect(calls).toHaveLength(1);
	});

	test("installed but logged out: models fail, so not logged in", async () => {
		const status = await probeAgy(fakeRun({ "agy --version": { ok: true, stdout: "1.3.6" } }), "agy", 0);
		expect(status).toMatchObject({ path: "agy", installed: true, version: "1.3.6", loggedIn: false, models: [] });
	});
});

describe("keepKnownPath", () => {
	const none = { path: null, installed: false, version: "", loggedIn: false, models: [] };
	test("a probe that cannot find agy keeps the last path it was found at", () => {
		const before = { path: "/home/agent/.local/bin/agy", installed: true, version: "1.3.6", loggedIn: true, models: [] };
		expect(keepKnownPath(before, none)).toEqual({ ...none, path: "/home/agent/.local/bin/agy", installed: true });
	});
	test("otherwise the new probe wins", () => {
		const after = { path: "/usr/bin/agy", installed: true, version: "1.4.0", loggedIn: false, models: [] };
		expect(keepKnownPath(none, after)).toEqual(after);
		expect(keepKnownPath(none, none)).toEqual(none);
	});
});

describe("uncheckedTools", () => {
	test("names tools this runner's rules were not checked against", () => {
		expect(uncheckedTools(["view_file", "write_to_file", "run_command"])).toEqual([]);
		expect(uncheckedTools(["view_file", "teleport_files"])).toEqual(["teleport_files"]);
	});
});

describe("probeAgy retry", () => {
	test("a models call that fails once is retried before calling it logged out", async () => {
		let modelCalls = 0;
		const status = await probeAgy(async (file, args) => {
			if (args[0] === "--version") return { ok: true, stdout: "1.3.6" };
			modelCalls += 1;
			return modelCalls === 1 ? { ok: false, stdout: "" } : { ok: true, stdout: "m-1\tM" };
		}, "agy", 0);
		expect(status).toMatchObject({ loggedIn: true, models: [{ id: "m-1", label: "M" }] });
		expect(modelCalls).toBe(2);
	});
});
