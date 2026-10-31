import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * A repository's own git settings can name programs git will run: an ssh
 * command, a pager, a credential helper, a filter for `git add`. A job that
 * can edit files in its folder could plant one there and have the runner's
 * own `git pull` / `commit` / `push` run it, beyond the job's permission
 * level. SAFE_GIT overrides the known keys on every call; this guard is the
 * second line: the files are read before the agent runs, and any change is
 * put back afterwards (and the run fails, committing nothing).
 */

export const GUARDED_GIT_FILES = [".git/config", ".git/config.worktree", ".git/info/attributes"] as const;

/** File path → its content, or null when it did not exist. */
export type GitSnapshot = ReadonlyMap<string, string | null>;

export function snapshotGitFiles(cwd: string): GitSnapshot {
	const snapshot = new Map<string, string | null>();
	for (const relative of GUARDED_GIT_FILES) {
		const file = path.join(cwd, relative);
		let content: string | null = null;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			// missing (or unreadable): recorded as absent
		}
		snapshot.set(file, content);
	}
	return snapshot;
}

/** The files whose content differs between two snapshots, with what to put back. */
export function changedGitFiles(before: GitSnapshot, after: GitSnapshot): { file: string; content: string | null }[] {
	const changed: { file: string; content: string | null }[] = [];
	for (const [file, content] of before) {
		if (after.get(file) !== content) changed.push({ file, content });
	}
	return changed;
}

/**
 * Run by the job user (it owns the clone) as `node -e SCRIPT <file> <json>`:
 * writes the content back through a temp file and a rename, or removes the
 * file when the JSON is null.
 */
export const RESTORE_SCRIPT = `
const fs = require("fs");
const file = process.argv[1];
const content = JSON.parse(process.argv[2]);
if (content === null) fs.rmSync(file, { force: true });
else {
	const temp = file + ".teez-tmp";
	fs.writeFileSync(temp, content);
	fs.renameSync(temp, file);
}
`;
