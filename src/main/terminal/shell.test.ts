import { describe, expect, test } from "vitest";
import { GIT_BASH, shellProgram, shellsAvailable } from "./shell.ts";

const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\m\\AppData\\Local" };
const PWSH7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const has =
	(...paths: string[]) =>
	(p: string): boolean =>
		paths.includes(p);

describe("shellProgram", () => {
	test("auto: PowerShell 7 when installed, Windows PowerShell otherwise", () => {
		expect(shellProgram("auto", env, "win32", has(PWSH7))).toEqual({ file: PWSH7, args: ["-NoLogo"], title: "pwsh" });
		expect(shellProgram("auto", env, "win32", has())).toEqual({ file: "powershell.exe", args: ["-NoLogo"], title: "powershell" });
	});
	test("powershell is Windows PowerShell", () => {
		expect(shellProgram("powershell", env, "win32", has(PWSH7))).toEqual({ file: "powershell.exe", args: ["-NoLogo"], title: "powershell" });
	});
	test("gitbash is Git's bash when it exists, else auto", () => {
		expect(shellProgram("gitbash", env, "win32", has(GIT_BASH))).toEqual({ file: GIT_BASH, args: ["--login", "-i"], title: "bash" });
		expect(shellProgram("gitbash", env, "win32", has(PWSH7))).toEqual({ file: PWSH7, args: ["-NoLogo"], title: "pwsh" });
	});
	test("cmd is cmd.exe", () => {
		expect(shellProgram("cmd", env, "win32", has())).toEqual({ file: "cmd.exe", args: [], title: "cmd" });
	});
	test("off Windows the choice is ignored: $SHELL", () => {
		expect(shellProgram("cmd", { SHELL: "/bin/zsh" }, "linux", has())).toEqual({ file: "/bin/zsh", args: [], title: "shell" });
	});
});

describe("shellsAvailable", () => {
	test("says what auto means and whether Git Bash is there", () => {
		expect(shellsAvailable(env, "win32", has(PWSH7, GIT_BASH))).toEqual({ auto: "PowerShell 7", gitBash: true });
		expect(shellsAvailable(env, "win32", has())).toEqual({ auto: "Windows PowerShell", gitBash: false });
	});
});
