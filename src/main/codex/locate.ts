import path from "node:path";

/**
 * Finds the Codex CLI's native executable. npm puts shims on PATH on Windows
 * (`codex.cmd`, `codex.ps1`) that would need a shell to run; TeezOS spawns
 * the real `codex.exe` from npm's vendor folder instead, so no shell ever
 * parses its arguments. See docs/superpowers/notes/2026-10-31-codex-protocol.md.
 */

const WINDOWS_TARGETS = [
	["codex-win32-x64", "x86_64-pc-windows-msvc"],
	["codex-win32-arm64", "aarch64-pc-windows-msvc"],
] as const;

export function resolveCodex(deps: {
	readonly platform: NodeJS.Platform;
	readonly env: NodeJS.ProcessEnv;
	readonly home: string;
	readonly pathEntries: readonly string[];
	readonly isFile: (file: string) => boolean;
}): string | null {
	const windows = deps.platform === "win32";
	const api = windows ? path.win32 : path.posix;
	const exe = windows ? "codex.exe" : "codex";
	const npmRoot = windows ? api.join(deps.env["APPDATA"] ?? api.join(deps.home, "AppData", "Roaming"), "npm", "node_modules", "@openai", "codex") : null;
	const candidates = [
		deps.env["TEEZAI_CODEX_PATH"],
		...(npmRoot
			? WINDOWS_TARGETS.map(([pkg, triple]) => api.join(npmRoot, "node_modules", "@openai", pkg, "vendor", triple, "bin", exe))
			: []),
		// Only a real executable on PATH: on Windows that is codex.exe, never a .cmd or .ps1 shim.
		...deps.pathEntries.map((dir) => api.join(dir, exe)),
	];
	for (const candidate of candidates) {
		if (candidate && deps.isFile(candidate)) return candidate;
	}
	return null;
}

/** `codex --version` prints "codex-cli 0.166.0". */
export function parseCodexVersion(output: string): string | null {
	return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null;
}

/**
 * The app-server protocol changes between releases, so TeezOS talks only to
 * the minor it was built and tested against (regenerate src/main/codex/protocol
 * and re-record the fixtures to move it).
 */
export const SUPPORTED_CODEX = { min: "0.166.0", belowMinor: "0.167.0" } as const;

function parts(version: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
	return 0;
}

export function isSupportedCodex(version: string): boolean {
	const v = parts(version);
	const min = parts(SUPPORTED_CODEX.min);
	const below = parts(SUPPORTED_CODEX.belowMinor);
	if (!v || !min || !below) return false;
	return compare(v, min) >= 0 && compare(v, below) < 0;
}
