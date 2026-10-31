import { win32 } from "node:path";
import type { ShellChoice } from "../../shared/modules.ts";

/**
 * Which program a new shell tab runs, from Settings → Terminal. Only these
 * fixed paths can come out of it — the window picks a choice, never a program.
 * Pure (the file check is passed in), so it is tested without a disk.
 */

export const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

type Env = Readonly<Record<string, string | undefined>>;
type Exists = (path: string) => boolean;

function powerShell7(env: Env, exists: Exists): string | null {
	const candidates = [
		win32.join(env["ProgramFiles"] ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
		env["LOCALAPPDATA"] ? win32.join(env["LOCALAPPDATA"], "Microsoft", "WindowsApps", "pwsh.exe") : "",
	];
	return candidates.find((candidate) => candidate !== "" && exists(candidate)) ?? null;
}

/** PowerShell 7 when installed, Windows PowerShell otherwise; $SHELL off Windows. */
export function autoShell(env: Env, platform: NodeJS.Platform, exists: Exists): string {
	if (platform !== "win32") return env["SHELL"] || "/bin/bash";
	return powerShell7(env, exists) ?? "powershell.exe";
}

export type ShellProgram = { readonly file: string; readonly args: readonly string[]; readonly title: string };

function describe(file: string, platform: NodeJS.Platform): ShellProgram {
	if (platform !== "win32") return { file, args: [], title: "shell" };
	if (/pwsh\.exe$/i.test(file)) return { file, args: ["-NoLogo"], title: "pwsh" };
	if (/powershell\.exe$/i.test(file)) return { file, args: ["-NoLogo"], title: "powershell" };
	if (/bash\.exe$/i.test(file)) return { file, args: ["--login", "-i"], title: "bash" };
	if (/cmd\.exe$/i.test(file)) return { file, args: [], title: "cmd" };
	return { file, args: [], title: "shell" };
}

/** Git Bash falls back to the automatic choice when Git is not installed where Git for Windows puts it. */
export function shellProgram(choice: ShellChoice, env: Env, platform: NodeJS.Platform, exists: Exists): ShellProgram {
	if (platform !== "win32") return describe(autoShell(env, platform, exists), platform);
	switch (choice) {
		case "powershell":
			return describe("powershell.exe", platform);
		case "gitbash":
			return describe(exists(GIT_BASH) ? GIT_BASH : autoShell(env, platform, exists), platform);
		case "cmd":
			return describe("cmd.exe", platform);
		default:
			return describe(autoShell(env, platform, exists), platform);
	}
}

/** What Settings → Terminal shows: what "Automatic" means here, and whether Git Bash can be picked. */
export function shellsAvailable(env: Env, platform: NodeJS.Platform, exists: Exists): { readonly auto: string; readonly gitBash: boolean } {
	if (platform !== "win32") return { auto: env["SHELL"] || "/bin/bash", gitBash: false };
	return { auto: powerShell7(env, exists) ? "PowerShell 7" : "Windows PowerShell", gitBash: exists(GIT_BASH) };
}
