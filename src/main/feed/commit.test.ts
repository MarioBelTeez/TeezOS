import { describe, expect, test, vi } from "vitest";
import { commitFeedNotes, type FeedGit } from "./commit.ts";

const ok = { ok: true, output: "" };

function fakeGit(overrides: Partial<FeedGit> = {}): FeedGit {
	return {
		commitPaths: vi.fn<FeedGit["commitPaths"]>(async () => ok),
		push: vi.fn<FeedGit["push"]>(async () => ok),
		pull: vi.fn<FeedGit["pull"]>(async () => ok),
		...overrides,
	};
}

describe("commitFeedNotes", () => {
	test("commits exactly the given paths, then pushes", async () => {
		const git = fakeGit();
		const result = await commitFeedNotes("C:/vault", ["a.md", "b.md"], "vault: feed — X", git);
		expect(git.commitPaths).toHaveBeenCalledWith("C:/vault", ["a.md", "b.md"], "vault: feed — X");
		expect(git.push).toHaveBeenCalledWith("C:/vault");
		expect(result).toEqual({ ok: true, message: "committed and pushed" });
	});

	test("a failed commit stops before pushing", async () => {
		const git = fakeGit({ commitPaths: vi.fn(async () => ({ ok: false, output: "index.lock exists" })) });
		const result = await commitFeedNotes("C:/vault", ["a.md"], "m", git);
		expect(git.push).not.toHaveBeenCalled();
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/^commit failed: index\.lock exists/);
	});

	test("a rejected push pulls fast-forward once and pushes again", async () => {
		const push = vi.fn<FeedGit["push"]>().mockResolvedValueOnce({ ok: false, output: "rejected (fetch first)" }).mockResolvedValueOnce(ok);
		const git = fakeGit({ push });
		const result = await commitFeedNotes("C:/vault", ["a.md"], "m", git);
		expect(git.pull).toHaveBeenCalledTimes(1);
		expect(push).toHaveBeenCalledTimes(2);
		expect(result).toEqual({ ok: true, message: "committed and pushed" });
	});

	test("a push that still fails leaves the commit and says so", async () => {
		const git = fakeGit({ push: vi.fn(async () => ({ ok: false, output: "no network" })) });
		const result = await commitFeedNotes("C:/vault", ["a.md"], "m", git);
		expect(result.ok).toBe(false);
		expect(result.message).toMatch(/^committed, but the push failed/);
		expect(result.message).toContain("no network");
	});
});
