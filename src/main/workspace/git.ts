import { execFile } from "node:child_process";

/**
 * Git, read-only: what the file tree and the title bar need to show.
 *
 * `--porcelain=v2 -z` because it is the format git promises not to change,
 * and NUL separators keep paths with spaces (half the vault) intact.
 * Anything that goes wrong — not a repository, git not installed — comes
 * back as null, and the tree simply draws without badges.
 */

/** The letters VS Code uses, so the badges read the same. */
export type GitLetter = "M" | "A" | "D" | "R" | "C" | "U";

export type GitStatus = {
	readonly branch: string;
	readonly upstream: string | null;
	readonly ahead: number;
	readonly behind: number;
	/** Workspace-relative path (forward slashes; folders end in "/") → letter. */
	readonly files: Readonly<Record<string, GitLetter>>;
};

export type GitCommit = {
	readonly hash: string;
	readonly short: string;
	readonly author: string;
	readonly when: string;
	readonly subject: string;
};

/** The text after the first `count` space-separated fields. */
function afterFields(line: string, count: number): string {
	let index = 0;
	for (let seen = 0; seen < count; seen += 1) {
		index = line.indexOf(" ", index);
		if (index === -1) return "";
		index += 1;
	}
	return line.slice(index);
}

function letterFor(xy: string): GitLetter {
	if (xy.includes("D")) return "D";
	if (xy[0] === "A") return "A";
	if (xy.includes("R")) return "R";
	return "M";
}

export function parseStatus(raw: string): GitStatus {
	let branch = "";
	let upstream: string | null = null;
	let ahead = 0;
	let behind = 0;
	const files: Record<string, GitLetter> = {};

	const fields = raw.split("\0");
	for (let i = 0; i < fields.length; i += 1) {
		const line = fields[i] ?? "";
		if (!line) continue;

		if (line.startsWith("# branch.head ")) {
			branch = line.slice("# branch.head ".length);
		} else if (line.startsWith("# branch.upstream ")) {
			upstream = line.slice("# branch.upstream ".length);
		} else if (line.startsWith("# branch.ab ")) {
			const match = /\+(\d+) -(\d+)/.exec(line);
			ahead = Number(match?.[1] ?? 0);
			behind = Number(match?.[2] ?? 0);
		} else if (line.startsWith("1 ")) {
			files[afterFields(line, 8)] = letterFor(line.slice(2, 4));
		} else if (line.startsWith("2 ")) {
			files[afterFields(line, 9)] = "R";
			i += 1; // the next NUL field is the original path
		} else if (line.startsWith("u ")) {
			files[afterFields(line, 10)] = "C";
		} else if (line.startsWith("? ")) {
			files[line.slice(2)] = "U";
		}
	}

	return { branch, upstream, ahead, behind, files };
}

/** Options every git call from the app carries. */
export const SAFE_GIT: readonly string[] = ["-c", "core.quotepath=false", "-c", "core.fsmonitor=false"];

function run(cwd: string, args: readonly string[], maxBuffer = 20 * 1024 * 1024): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			"git",
			// quotepath=false keeps non-ASCII names readable instead of \ooo escapes.
			// fsmonitor=false: a repository's own .git/config could otherwise name a
			// program for git to run on every status — in this process, unasked.
			// --no-optional-locks: a background status must never take index.lock
			// out from under an agent's `git add`.
			["--no-optional-locks", ...SAFE_GIT, ...args],
			{ cwd, maxBuffer, timeout: 15_000, windowsHide: true, encoding: "utf8" },
			(error, stdout) => resolve(error ? null : stdout),
		);
	});
}

export async function readGitStatus(root: string): Promise<GitStatus | null> {
	const raw = await run(root, ["status", "--porcelain=v2", "--branch", "-z"]);
	return raw === null ? null : parseStatus(raw);
}

/**
 * Every changed path, untracked files listed one by one (not as their new
 * folder), so a before/after difference names the exact files. Null when
 * the folder is not a repository or git is missing.
 */
export async function readChangedPaths(root: string): Promise<string[] | null> {
	const raw = await run(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
	return raw === null ? null : Object.keys(parseStatus(raw).files);
}

/** The committed version of a file, or null if HEAD does not have it. */
export async function readHeadFile(root: string, relative: string): Promise<string | null> {
	return run(root, ["show", `HEAD:${relative}`]);
}

export async function readLog(root: string, count = 30): Promise<GitCommit[]> {
	const raw = await run(root, [
		"log",
		`-n${Math.max(1, Math.min(200, count))}`,
		"--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1e",
	]);
	if (!raw) return [];
	return raw
		.split("\x1e")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => {
			const [hash = "", short = "", author = "", when = "", subject = ""] = record.split("\x1f");
			return { hash, short, author, when, subject };
		});
}
