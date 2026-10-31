import { commitPaths, pull, push, type GitResult } from "../workspace/git-write.ts";
import type { FeedCommit } from "./runner.ts";

/**
 * The feed's automatic commit: exactly the paths a job wrote (commitPaths never
 * stages anything else, so Antigravity's or the user's unfinished work in the shared
 * vault stays out), then a push. A push refused because origin moved on gets one
 * fast-forward pull and a second push; anything else is reported, not retried.
 */

export type FeedGit = {
	readonly commitPaths: (root: string, paths: readonly string[], message: string) => Promise<GitResult>;
	readonly push: (root: string) => Promise<GitResult>;
	readonly pull: (root: string) => Promise<GitResult>;
};

const LIVE_GIT: FeedGit = { commitPaths, push, pull };

/** The last line of git's output, short enough for a log line. */
const brief = (output: string): string => (output.trim().split("\n").at(-1) ?? "").slice(0, 300);

export async function commitFeedNotes(vault: string, paths: readonly string[], message: string, git: FeedGit = LIVE_GIT): Promise<FeedCommit> {
	const committed = await git.commitPaths(vault, paths, message);
	if (!committed.ok) return { ok: false, message: `commit failed: ${brief(committed.output)}` };
	let pushed = await git.push(vault);
	if (!pushed.ok) {
		const pulled = await git.pull(vault);
		if (pulled.ok) pushed = await git.push(vault);
	}
	return pushed.ok
		? { ok: true, message: "committed and pushed" }
		: { ok: false, message: `committed, but the push failed (push from the Git panel): ${brief(pushed.output)}` };
}
