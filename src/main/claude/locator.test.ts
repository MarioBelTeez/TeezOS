import { describe, test, expect } from "vitest";
import { resolveClaudeBinary, type LocateDeps } from "./locator.ts";

/**
 * The locator exists because of a trap found while spiking this app: the
 * `claude` on PATH installed by npm is a shell shim, not a launchable binary.
 * Handing that path to the Agent SDK fails with a message blaming libc, which
 * sends you hunting for a platform problem that isn't there. The locator must
 * return the real executable and never the shim.
 */

const WIN_HOME = "C:\\Users\\user";
const WIN_REAL =
	"C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
const WIN_SHIM = "C:\\Users\\user\\AppData\\Roaming\\npm\\claude";

function deps(present: readonly string[], overrides: Partial<LocateDeps> = {}): LocateDeps {
	const set = new Set(present.map((p) => p.toLowerCase()));
	return {
		platform: "win32",
		home: WIN_HOME,
		pathEntries: [],
		isFile: (p) => set.has(p.toLowerCase()),
		...overrides,
	};
}

describe("resolveClaudeBinary", () => {
	test("finds the real executable in the npm global install on Windows", () => {
		const result = resolveClaudeBinary(deps([WIN_REAL, WIN_SHIM]));
		expect(result).toEqual({ ok: true, path: WIN_REAL, source: "npm-global" });
	});

	test("never returns the npm shim, even when it is the only thing on PATH", () => {
		const result = resolveClaudeBinary(
			deps([WIN_SHIM], { pathEntries: ["C:\\Users\\user\\AppData\\Roaming\\npm"] }),
		);
		expect(result.ok).toBe(false);
	});

	test("an explicit override wins over everything else", () => {
		const custom = "D:\\tools\\claude.exe";
		const result = resolveClaudeBinary(
			deps([custom, WIN_REAL], { override: custom }),
		);
		expect(result).toEqual({ ok: true, path: custom, source: "override" });
	});

	test("an override that does not exist fails loudly, naming the path", () => {
		const result = resolveClaudeBinary(
			deps([WIN_REAL], { override: "D:\\gone\\claude.exe" }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("D:\\gone\\claude.exe");
	});

	test("falls back to a real executable found on PATH", () => {
		const onPath = "C:\\tools\\bin\\claude.exe";
		const result = resolveClaudeBinary(
			deps([onPath], { pathEntries: ["C:\\tools\\bin"] }),
		);
		expect(result).toEqual({ ok: true, path: onPath, source: "path" });
	});

	test("reports a clear reason when nothing is found", () => {
		const result = resolveClaudeBinary(deps([]));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/claude code/i);
	});

	test("finds the npm global install on Linux", () => {
		const real = "/home/user/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude";
		const result = resolveClaudeBinary({
			platform: "linux",
			home: "/home/user",
			pathEntries: [],
			isFile: (p) => p === real,
		});
		expect(result).toEqual({ ok: true, path: real, source: "npm-global" });
	});

	test("on Linux an extensionless PATH hit is accepted, but not the npm shim dir", () => {
		const shim = "/home/user/.npm-global/bin/claude";
		const result = resolveClaudeBinary({
			platform: "linux",
			home: "/home/user",
			pathEntries: ["/home/user/.npm-global/bin"],
			isFile: (p) => p === shim,
		});
		expect(result.ok).toBe(false);
	});
});
