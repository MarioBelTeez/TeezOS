import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceWatcher, parentOf, type FsChange } from "./watcher.ts";

function waitForChange(changes: FsChange[], predicate: (c: FsChange) => boolean, ms = 3000): Promise<FsChange | undefined> {
	return new Promise((resolve) => {
		const started = Date.now();
		const timer = setInterval(() => {
			const hit = changes.find(predicate);
			if (hit || Date.now() - started > ms) {
				clearInterval(timer);
				resolve(hit);
			}
		}, 50);
	});
}

describe("WorkspaceWatcher", () => {
	test("parentOf gives the folder, '' for the root", () => {
		expect(parentOf("a.txt")).toBe("");
		expect(parentOf("src\\main\\x.ts")).toBe("src/main");
	});

	test("reports the folder of a file changed in the root and in a subfolder", async () => {
		const root = mkdtempSync(join(tmpdir(), "teez-watch-"));
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "a.txt"), "1");
		writeFileSync(join(root, "src", "b.ts"), "1");
		const changes: FsChange[] = [];
		const watcher = new WorkspaceWatcher(root, (change) => changes.push(change));
		try {
			expect(watcher.active).toBe(true);
			await new Promise((r) => setTimeout(r, 100));
			appendFileSync(join(root, "a.txt"), "2");
			expect(await waitForChange(changes, (c) => c.dirs.includes(""))).toBeDefined();
			appendFileSync(join(root, "src", "b.ts"), "2");
			expect(await waitForChange(changes, (c) => c.dirs.includes("src"))).toBeDefined();
		} finally {
			watcher.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
