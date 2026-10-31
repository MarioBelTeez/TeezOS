import { describe, expect, test, vi } from "vitest";
import { FeedRunner, type FeedRunnerDeps } from "./runner.ts";
import type { FeedItem, FeedStatus } from "../../shared/feed.ts";
import type { Completion } from "./engines/service.ts";
import type { WriteResult } from "./writer.ts";

const JSON_REPLY = JSON.stringify({ title: "How hooks work", summary: "A talk.", keyPoints: [], quotes: [], concepts: [{ name: "Hooks", definition: "d", isNew: true }], skill: null });
const answer = (text: string): Completion => ({ ok: true, text, engine: "gemini", model: "gemini-2.5-flash" });
const WROTE: WriteResult = { ok: true, title: "How hooks work", changed: ["reference/sources/How hooks work.md", "brain/concepts/Hooks.md"], drafts: [], warnings: [] };

function makeDeps(overrides: Partial<FeedRunnerDeps> = {}) {
	const saved: FeedItem[][] = [];
	const statuses: FeedStatus[] = [];
	const deps: FeedRunnerDeps = {
		vault: () => "C:/vault",
		groqKey: () => "gsk_test",
		readSource: vi.fn<FeedRunnerDeps["readSource"]>(async () => ({ ok: true as const, text: "# transcript" })),
		workDir: { create: async (id) => `C:/Temp/teezai-feed-${id}`, remove: vi.fn<(dir: string) => Promise<void>>(async () => undefined) },
		conceptTitles: async () => ["Hooks"],
		complete: vi.fn<FeedRunnerDeps["complete"]>(async () => answer(JSON_REPLY)),
		write: vi.fn<FeedRunnerDeps["write"]>(async () => WROTE),
		save: (items) => saved.push(items),
		emit: (items) => {
			const s = items[0]?.status;
			if (s && statuses.at(-1) !== s) statuses.push(s);
		},
		now: () => 50,
		...overrides,
	};
	return { deps, saved, statuses };
}

/** An engine that stays open until the job's signal fires. */
function hangingComplete(): FeedRunnerDeps["complete"] {
	return (_item, _source, _titles, _dir, signal) =>
		new Promise((resolve) => {
			signal.addEventListener("abort", () => resolve({ ok: false, kind: "other", error: "Cancelled.", engine: "gemini" }));
		});
}

describe("FeedRunner", () => {
	test("a job reads, asks the engine, writes, and ends done with its title, notes and drafts", async () => {
		const { deps, saved, statuses } = makeDeps({ write: vi.fn(async () => ({ ...WROTE, drafts: ["hook-pattern"] })) });
		const runner = new FeedRunner(deps);
		const item = runner.add("https://youtu.be/1", "auto", "for hooks") as FeedItem;
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("done"));
		const done = runner.items()[0]!;
		expect(done.title).toBe("How hooks work");
		expect(done.changed).toEqual(WROTE.changed);
		expect(done.drafts).toEqual(["hook-pattern"]);
		expect(done.error).toBeNull();
		expect(statuses).toEqual(["queued", "reading", "writing", "done"]);
		expect(saved.length).toBeGreaterThan(0);
		expect(deps.readSource).toHaveBeenCalledWith(expect.objectContaining({ id: item.id }), `C:/Temp/teezai-feed-${item.id}`, "gsk_test", expect.any(AbortSignal));
		expect(deps.complete).toHaveBeenCalledWith(expect.objectContaining({ id: item.id }), { kind: "text", text: "# transcript" }, ["Hooks"], expect.any(String), expect.any(AbortSignal));
		expect(deps.write).toHaveBeenCalledWith("C:/vault", expect.objectContaining({ id: item.id }), expect.objectContaining({ title: "How hooks work" }), 50);
		expect(deps.workDir.remove).toHaveBeenCalledTimes(1);
		expect(done.log.join("\n")).toContain("answered by Gemini (gemini-2.5-flash)");
	});

	test("a finished job commits exactly the notes it wrote and logs the result", async () => {
		const commit = vi.fn<NonNullable<FeedRunnerDeps["commit"]>>(async () => ({ ok: true, message: "committed and pushed" }));
		const { deps } = makeDeps({ commit });
		const runner = new FeedRunner(deps);
		runner.add("https://youtu.be/1", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("done"));
		expect(commit).toHaveBeenCalledWith("C:/vault", WROTE.changed, "vault: feed — How hooks work");
		expect(runner.items()[0]?.log.join("\n")).toContain("committed and pushed");
	});

	test("a failed commit is logged but the job still ends done", async () => {
		const { deps } = makeDeps({ commit: async () => ({ ok: false, message: "commit failed: nothing to commit" }) });
		const runner = new FeedRunner(deps);
		runner.add("https://youtu.be/1", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("done"));
		expect(runner.items()[0]?.log.join("\n")).toContain("commit failed");
	});

	test("nothing written means nothing committed", async () => {
		const commit = vi.fn<NonNullable<FeedRunnerDeps["commit"]>>(async () => ({ ok: true, message: "" }));
		const { deps } = makeDeps({ commit, filed: async () => "reference/sources/How hooks work.md" });
		const runner = new FeedRunner(deps);
		runner.add("https://youtu.be/1", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("done"));
		expect(commit).not.toHaveBeenCalled();
	});

	test("a link already filed in the vault is skipped before anything is read or asked", async () => {
		const { deps } = makeDeps({ filed: async () => "reference/sources/How hooks work.md" });
		const runner = new FeedRunner(deps);
		runner.add("https://youtu.be/1", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("done"));
		expect(runner.items()[0]?.title).toBe("How hooks work");
		expect(runner.items()[0]?.changed).toEqual([]);
		expect(runner.items()[0]?.log.join("\n")).toMatch(/Already filed/);
		expect(deps.readSource).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
	});

	test("a PDF goes to the engine as bytes", async () => {
		const bytes = new Uint8Array([37, 80, 68, 70]);
		const { deps } = makeDeps({ readSource: async () => ({ ok: true as const, text: "", pdf: bytes }) });
		const runner = new FeedRunner(deps);
		runner.add("https://example.com/p.pdf", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("done"));
		expect(deps.complete).toHaveBeenCalledWith(expect.anything(), { kind: "pdf", bytes }, expect.anything(), expect.any(String), expect.any(AbortSignal));
	});

	test("a source that cannot be read fails the job with the reason, and the folder is still removed", async () => {
		const { deps } = makeDeps({ readSource: async () => ({ ok: false as const, error: "The page had no readable text." }) });
		const runner = new FeedRunner(deps);
		runner.add("https://example.com/post", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("failed"));
		expect(runner.items()[0]?.error).toBe("The page had no readable text.");
		expect(deps.complete).not.toHaveBeenCalled();
		expect(deps.workDir.remove).toHaveBeenCalled();
	});

	test("an engine failure (quota, key) fails the job with its message and writes nothing", async () => {
		const { deps } = makeDeps({ complete: async () => ({ ok: false, kind: "quota", error: "Gemini quota or rate limit reached.", engine: "gemini" }) });
		const runner = new FeedRunner(deps);
		runner.add("https://example.com/post", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("failed"));
		expect(runner.items()[0]?.error).toContain("quota");
		expect(deps.write).not.toHaveBeenCalled();
	});

	test("an answer that is not JSON is asked for once more; a valid second answer is used", async () => {
		const complete = vi.fn<FeedRunnerDeps["complete"]>().mockResolvedValueOnce(answer("Sorry, here is a summary.")).mockResolvedValueOnce(answer(JSON_REPLY));
		const { deps } = makeDeps({ complete });
		const runner = new FeedRunner(deps);
		runner.add("https://example.com/post", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("done"));
		expect(complete).toHaveBeenCalledTimes(2);
	});

	test("two answers that are not JSON fail the job without writing", async () => {
		const complete = vi.fn<FeedRunnerDeps["complete"]>(async () => answer("no json here"));
		const { deps } = makeDeps({ complete });
		const runner = new FeedRunner(deps);
		runner.add("https://example.com/post", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("failed"));
		expect(complete).toHaveBeenCalledTimes(2);
		expect(runner.items()[0]?.error).toMatch(/JSON/);
		expect(deps.write).not.toHaveBeenCalled();
	});

	test("a writer that cannot write fails the job", async () => {
		const { deps } = makeDeps({ write: async () => ({ ok: false, error: "The vault folder was not found." }) });
		const runner = new FeedRunner(deps);
		runner.add("https://example.com/post", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("failed"));
		expect(runner.items()[0]?.error).toBe("The vault folder was not found.");
	});

	test("writer warnings go to the log", async () => {
		const { deps } = makeDeps({ write: async () => ({ ...WROTE, warnings: ["Left brain/concepts/Big.md alone: it is larger than 1 MB."] }) });
		const runner = new FeedRunner(deps);
		runner.add("https://example.com/post", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("done"));
		expect(runner.items()[0]?.log.join("\n")).toContain("larger than 1 MB");
	});

	test("a dependency that throws fails the job instead of wedging the queue", async () => {
		const throwing = vi.fn<FeedRunnerDeps["vault"]>().mockImplementationOnce(() => {
			throw new Error("settings unreadable");
		}).mockReturnValue("C:/vault");
		const { deps } = makeDeps({ vault: throwing });
		const runner = new FeedRunner(deps);
		const first = runner.add("https://youtu.be/1", "auto", "") as FeedItem;
		runner.add("https://youtu.be/2", "auto", "");
		await vi.waitFor(() => expect(runner.items().find((i) => i.id === first.id)?.status).toBe("failed"));
		expect(runner.items().find((i) => i.id === first.id)?.error).toMatch(/settings unreadable/);
		await vi.waitFor(() => expect(runner.items()[1]?.status).toBe("done"));
		const { deps: thrower } = makeDeps({ complete: async () => { throw new Error("boom"); } });
		const other = new FeedRunner(thrower);
		other.add("https://youtu.be/1", "auto", "");
		await vi.waitFor(() => expect(other.items()[0]?.error).toMatch(/boom/));
	});

	test("the Groq key never reaches the log or an error", async () => {
		const { deps } = makeDeps({
			readSource: async () => ({ ok: false as const, error: "/watch failed: bad key gsk_test" }),
		});
		const runner = new FeedRunner(deps);
		runner.add("https://youtu.be/1", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("failed"));
		const item = runner.items()[0]!;
		expect(JSON.stringify(item)).not.toContain("gsk_test");
	});

	test("refuses input it cannot read, and a source already waiting", () => {
		const { deps } = makeDeps({ complete: hangingComplete() });
		const runner = new FeedRunner(deps);
		expect(runner.add("hello", "auto", "")).toMatchObject({ error: expect.any(String) });
		runner.add("https://youtu.be/1", "auto", "");
		expect(runner.add("https://youtu.be/1", "auto", "")).toMatchObject({ error: expect.any(String) });
		expect(runner.add("https://youtu.be/2", "auto", "x".repeat(1001))).toMatchObject({ error: expect.any(String) });
		expect(runner.add("https://youtu.be/2", "bogus" as never, "")).toMatchObject({ error: expect.any(String) });
		runner.stop();
	});

	test("fails cleanly with no vault", async () => {
		const runner = new FeedRunner(makeDeps({ vault: () => null }).deps);
		runner.add("https://youtu.be/1", "auto", "");
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("failed"));
		expect(runner.items()[0]?.error).toMatch(/vault/);
	});

	test("one at a time; cancel stops the running job and the next one starts", async () => {
		const first = vi.fn<FeedRunnerDeps["complete"]>(hangingComplete());
		const { deps } = makeDeps({ complete: first });
		const runner = new FeedRunner(deps);
		const a = runner.add("https://youtu.be/1", "auto", "") as FeedItem;
		const b = runner.add("https://youtu.be/2", "auto", "") as FeedItem;
		await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
		expect(runner.items().find((i) => i.id === b.id)?.status).toBe("queued");
		first.mockImplementation(async () => answer(JSON_REPLY));
		runner.cancel(a.id);
		await vi.waitFor(() => expect(runner.items().find((i) => i.id === b.id)?.status).toBe("done"));
		expect(runner.items().find((i) => i.id === a.id)?.status).toBe("cancelled");
		expect(deps.write).toHaveBeenCalledTimes(1);
		expect(deps.workDir.remove).toHaveBeenCalledTimes(2);
	});

	test("a cancelled job writes nothing even if the engine answered at the last moment", async () => {
		let release: (c: Completion) => void = () => undefined;
		const { deps } = makeDeps({ complete: () => new Promise<Completion>((resolve) => (release = resolve)) });
		const runner = new FeedRunner(deps);
		const a = runner.add("https://youtu.be/1", "auto", "") as FeedItem;
		await vi.waitFor(() => expect(deps.readSource).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 5));
		runner.cancel(a.id);
		release(answer(JSON_REPLY));
		await vi.waitFor(() => expect(deps.workDir.remove).toHaveBeenCalled());
		expect(deps.write).not.toHaveBeenCalled();
		expect(runner.items()[0]?.status).toBe("cancelled");
	});

	test("a cancel during the write still lists the notes that were written", async () => {
		let release: (r: WriteResult) => void = () => undefined;
		const write = vi.fn<FeedRunnerDeps["write"]>(() => new Promise<WriteResult>((resolve) => (release = resolve)));
		const { deps } = makeDeps({ write });
		const runner = new FeedRunner(deps);
		const a = runner.add("https://youtu.be/1", "auto", "") as FeedItem;
		await vi.waitFor(() => expect(write).toHaveBeenCalled());
		runner.cancel(a.id);
		release(WROTE);
		await vi.waitFor(() => expect(deps.workDir.remove).toHaveBeenCalled());
		expect(runner.items()[0]?.status).toBe("cancelled");
		expect(runner.items()[0]?.changed).toEqual(WROTE.changed);
	});

	test("retry requeues a failed job; load restores items without losing them", async () => {
		const { deps } = makeDeps({ vault: () => null });
		const runner = new FeedRunner(deps);
		const item = runner.add("https://youtu.be/1", "auto", "") as FeedItem;
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("failed"));
		const other = new FeedRunner(makeDeps().deps);
		other.load(runner.items());
		expect(other.items()[0]?.status).toBe("failed");
		other.retry(item.id);
		await vi.waitFor(() => expect(other.items()[0]?.status).toBe("done"));
		expect(other.items()[0]?.title).toBe("How hooks work");
	});

	test("while the module is off nothing starts: loaded and added jobs wait, and start when it is back on", async () => {
		let enabled = false;
		const { deps } = makeDeps({ paused: () => !enabled });
		const runner = new FeedRunner(deps);
		runner.load([queued("job-a", 1)]);
		runner.add("https://youtu.be/2", "auto", "");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(deps.readSource).not.toHaveBeenCalled();
		expect(runner.items().map((i) => i.status)).toEqual(["queued", "queued"]);
		enabled = true;
		runner.resume();
		await vi.waitFor(() => expect(runner.items()[0]?.status).toBe("done"));
	});

	test("turning the module off cancels the running job; queued ones wait", async () => {
		let enabled = true;
		const complete = vi.fn<FeedRunnerDeps["complete"]>(hangingComplete());
		const { deps } = makeDeps({ complete, paused: () => !enabled });
		const runner = new FeedRunner(deps);
		const first = runner.add("https://youtu.be/1", "auto", "") as FeedItem;
		const second = runner.add("https://youtu.be/2", "auto", "") as FeedItem;
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
		enabled = false;
		runner.pause();
		await vi.waitFor(() => expect(runner.items().find((i) => i.id === first.id)?.status).toBe("cancelled"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(complete).toHaveBeenCalledTimes(1);
		expect(runner.items().find((i) => i.id === second.id)?.status).toBe("queued");
	});
});

/** A queued job as feed.json would hold it. */
function queued(id: string, createdAt: number): FeedItem {
	return {
		id,
		source: "https://youtu.be/1",
		input: "video",
		kind: "auto",
		note: "",
		status: "queued",
		createdAt,
		startedAt: null,
		finishedAt: null,
		title: "",
		log: [],
		changed: [],
		drafts: [],
		error: null,
	};
}
