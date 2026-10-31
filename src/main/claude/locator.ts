/**
 * Find the Claude Code executable this app should drive.
 *
 * Why this is not just `which claude`: npm's global install puts a *shell shim*
 * on PATH. Handing that path to the Agent SDK fails with a message about the
 * binary not matching the system's libc, which reads like a platform problem
 * and is really "that file is a script". The real executable lives inside the
 * package directory. So PATH is the last resort, npm shim directories are
 * skipped outright, and on Windows only a genuine `.exe` counts.
 *
 * Pure and dependency-injected: the platform, home directory, PATH entries and
 * the file check all arrive as arguments, so every branch is testable on any
 * host without touching the real filesystem.
 */

export type LocateDeps = {
	readonly platform: NodeJS.Platform;
	readonly home: string;
	readonly pathEntries: readonly string[];
	readonly isFile: (path: string) => boolean;
	/** An explicit path from settings. Wins outright, or fails loudly. */
	readonly override?: string;
};

export type LocateResult =
	| {
			readonly ok: true;
			readonly path: string;
			readonly source: "override" | "npm-global" | "path";
	  }
	| { readonly ok: false; readonly reason: string };

/** Path fragments that mark a directory as holding npm's shims, not binaries. */
const SHIM_DIR_MARKERS: readonly string[] = [
	"/npm/",
	"/.npm-global/",
	"/npm-global/",
	"/node_modules/.bin/",
];

const PACKAGE_SUBPATH = [
	"node_modules",
	"@anthropic-ai",
	"claude-code",
	"bin",
] as const;

function isWindows(platform: NodeJS.Platform): boolean {
	return platform === "win32";
}

/** Join using the separator of the *target* platform, not the host's. */
function joinFor(platform: NodeJS.Platform, ...parts: readonly string[]): string {
	const sep = isWindows(platform) ? "\\" : "/";
	const cleaned = parts.map((part, index) =>
		index === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, ""),
	);
	return cleaned.join(sep);
}

/** Lower-cased, forward-slashed, with a trailing slash — for marker matching. */
function normalizeDir(dir: string): string {
	return `${dir.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()}/`;
}

function isShimDirectory(dir: string): boolean {
	const normalized = normalizeDir(dir);
	return SHIM_DIR_MARKERS.some((marker) => normalized.includes(marker));
}

/** Where a global npm install puts the package itself, per platform. */
function npmGlobalCandidates(deps: LocateDeps): readonly string[] {
	const exe = isWindows(deps.platform) ? "claude.exe" : "claude";

	if (isWindows(deps.platform)) {
		return [
			joinFor(
				deps.platform,
				deps.home,
				"AppData",
				"Roaming",
				"npm",
				...PACKAGE_SUBPATH,
				exe,
			),
		];
	}

	return [
		joinFor(deps.platform, deps.home, ".npm-global", "lib", ...PACKAGE_SUBPATH, exe),
		joinFor(deps.platform, "/usr/local/lib", ...PACKAGE_SUBPATH, exe),
		joinFor(deps.platform, "/usr/lib", ...PACKAGE_SUBPATH, exe),
		joinFor(deps.platform, deps.home, ".local/lib", ...PACKAGE_SUBPATH, exe),
	];
}

function searchPath(deps: LocateDeps): string | null {
	// On Windows a `.cmd` is as much a shim as the extensionless file; only a
	// real executable can be spawned by the SDK.
	const names = isWindows(deps.platform) ? ["claude.exe"] : ["claude"];

	for (const dir of deps.pathEntries) {
		if (!dir || isShimDirectory(dir)) continue;
		for (const name of names) {
			const candidate = joinFor(deps.platform, dir, name);
			if (deps.isFile(candidate)) return candidate;
		}
	}
	return null;
}

export function resolveClaudeBinary(deps: LocateDeps): LocateResult {
	if (deps.override) {
		return deps.isFile(deps.override)
			? { ok: true, path: deps.override, source: "override" }
			: {
					ok: false,
					reason: `The configured Claude Code path does not exist: ${deps.override}`,
				};
	}

	for (const candidate of npmGlobalCandidates(deps)) {
		if (deps.isFile(candidate)) {
			return { ok: true, path: candidate, source: "npm-global" };
		}
	}

	const onPath = searchPath(deps);
	if (onPath) return { ok: true, path: onPath, source: "path" };

	return {
		ok: false,
		reason:
			"Could not find the Claude Code executable. Install it with " +
			"`npm install -g @anthropic-ai/claude-code`, or set the path in settings. " +
			"Note that the `claude` on PATH is usually npm's shim, not the executable.",
	};
}
