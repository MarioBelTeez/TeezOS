import { execFile } from "node:child_process";
import { resolveInside } from "./guard.ts";
import { SAFE_GIT } from "./git.ts";

/**
 * The few git commands that change things, each one explicit. Commit stages
 * exactly the paths the user ticked — never `add -A`, because a shared
 * working tree (the vault is shared with Antigravity) can hold someone else's
 * unfinished work. Pull is fast-forward only, so it can never invent a merge.
 */

export type GitResult = { readonly ok: boolean; readonly output: string };

function git(root: string, args: readonly string[], timeout = 60_000): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			[...SAFE_GIT, ...args],
			{ cwd: root, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
			(error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}`.trim() }),
		);
	});
}

export async function commitPaths(root: string, paths: readonly string[], message: string): Promise<GitResult> {
	const subject = message.trim();
	if (!subject) return { ok: false, output: "A commit needs a message." };
	if (paths.length === 0) return { ok: false, output: "Tick at least one file to commit." };
	for (const p of paths) {
		// A folder entry from status ends in "/"; the guard wants it without.
		if (!resolveInside(root, p.replace(/\/$/, "")).ok) return { ok: false, output: `Refused path: ${p}` };
	}
	const added = await git(root, ["add", "--all", "--", ...paths]);
	if (!added.ok) return added;
	return git(root, ["commit", "-m", subject, "--", ...paths]);
}

export function push(root: string): Promise<GitResult> {
	return git(root, ["push"], 120_000);
}

export function pull(root: string): Promise<GitResult> {
	return git(root, ["pull", "--ff-only"], 120_000);
}
