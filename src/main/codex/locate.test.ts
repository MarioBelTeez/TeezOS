import { describe, expect, test } from "vitest";
import { isSupportedCodex, parseCodexVersion, resolveCodex } from "./locate.ts";

const APPDATA = "C:\\Users\\user\\AppData\\Roaming";
const NPM_EXE =
	"C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";

describe("resolveCodex", () => {
	test("finds the native exe npm installs on Windows", () => {
		const found = resolveCodex({
			platform: "win32",
			env: { APPDATA },
			home: "C:\\Users\\user",
			pathEntries: [],
			isFile: (file) => file === NPM_EXE,
		});
		expect(found).toBe(NPM_EXE);
	});

	test("never returns npm's codex.cmd shim from PATH", () => {
		const found = resolveCodex({
			platform: "win32",
			env: { APPDATA: "C:\\nowhere" },
			home: "C:\\Users\\user",
			pathEntries: ["C:\\Users\\user\\AppData\\Roaming\\npm"],
			isFile: (file) => file.endsWith("codex.cmd") || file.endsWith("codex.ps1"),
		});
		expect(found).toBeNull();
	});

	test("TEEZAI_CODEX_PATH wins", () => {
		const found = resolveCodex({
			platform: "win32",
			env: { APPDATA, TEEZAI_CODEX_PATH: "D:\\tools\\codex.exe" },
			home: "C:\\Users\\user",
			pathEntries: [],
			isFile: (file) => file === NPM_EXE || file === "D:\\tools\\codex.exe",
		});
		expect(found).toBe("D:\\tools\\codex.exe");
	});

	test("finds codex on PATH on Linux", () => {
		const found = resolveCodex({
			platform: "linux",
			env: {},
			home: "/home/user",
			pathEntries: ["/usr/local/bin"],
			isFile: (file) => file === "/usr/local/bin/codex",
		});
		expect(found).toBe("/usr/local/bin/codex");
	});

	test("returns null when nothing is installed", () => {
		expect(resolveCodex({ platform: "win32", env: { APPDATA }, home: "C:\\Users\\user", pathEntries: ["C:\\tools"], isFile: () => false })).toBeNull();
	});
});

describe("Codex version", () => {
	test("parses `codex --version`", () => {
		expect(parseCodexVersion("codex-cli 0.166.0\n")).toBe("0.166.0");
		expect(parseCodexVersion("nonsense")).toBeNull();
	});

	test("supports the recorded minor only", () => {
		expect(isSupportedCodex("0.166.0")).toBe(true);
		expect(isSupportedCodex("0.166.3")).toBe(true);
		expect(isSupportedCodex("0.167.0")).toBe(false);
		expect(isSupportedCodex("0.165.9")).toBe(false);
		expect(isSupportedCodex("1.166.0")).toBe(false);
	});
});
