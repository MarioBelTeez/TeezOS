import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobFolders } from "./live.ts";

let base: string;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "feed-live-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("jobFolders", () => {
	test("each job gets a fresh teezai-feed-<id> folder, removed afterwards", async () => {
		const folders = jobFolders(base);
		mkdirSync(join(base, "teezai-feed-job-1"));
		writeFileSync(join(base, "teezai-feed-job-1", "stale.txt"), "old");
		const dir = await folders.create("job-1");
		expect(dir).toBe(join(base, "teezai-feed-job-1"));
		expect(existsSync(join(dir, "stale.txt"))).toBe(false);
		await folders.remove(dir);
		expect(existsSync(dir)).toBe(false);
	});
	test("refuses ids and folders that are not a job's", async () => {
		const folders = jobFolders(base);
		await expect(folders.create("../escape")).rejects.toThrow();
		mkdirSync(join(base, "keep"));
		await folders.remove(join(base, "keep"));
		expect(existsSync(join(base, "keep"))).toBe(true);
	});
	test("sweep clears day-old folders left by a run TeezAI quit during, never a recent one or anything else", () => {
		mkdirSync(join(base, "teezai-feed-old"));
		mkdirSync(join(base, "teezai-feed-recent"));
		mkdirSync(join(base, "other"));
		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
		utimesSync(join(base, "teezai-feed-old"), twoDaysAgo, twoDaysAgo);
		utimesSync(join(base, "other"), twoDaysAgo, twoDaysAgo);
		jobFolders(base).sweep();
		expect(existsSync(join(base, "teezai-feed-old"))).toBe(false);
		// Possibly another TeezAI's running job.
		expect(existsSync(join(base, "teezai-feed-recent"))).toBe(true);
		expect(existsSync(join(base, "other"))).toBe(true);
	});
	test("the folder handed out is the real path, so reads under a linked TEMP are not refused", async () => {
		const real = mkdtempSync(join(tmpdir(), "feed-real-"));
		const link = join(base, "linked-temp");
		try {
			symlinkSync(real, link, "junction");
			const folders = jobFolders(link);
			const dir = await folders.create("job-2");
			expect(dir).toBe(join(realpathSync.native(real), "teezai-feed-job-2"));
			await folders.remove(dir);
			expect(existsSync(dir)).toBe(false);
		} finally {
			rmSync(link, { force: true });
			rmSync(real, { recursive: true, force: true });
		}
	});
});
