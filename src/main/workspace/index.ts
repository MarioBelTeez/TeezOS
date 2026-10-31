import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { SAFE_GIT } from "./git.ts";

/**
 * Every file in a workspace, for quick open. In a git repository git answers
 * (it already knows what .gitignore leaves out, and it is fast); elsewhere a
 * bounded walk that skips the usual dependency and build folders.
 */

const SKIP = new Set([".git", "node_modules", "dist", "out", "release", ".next", ".venv", "venv", "__pycache__", "target", ".cache", ".turbo", "coverage"]);
const LIMIT = 50_000;

function gitFiles(root: string): Promise<string[] | null> {
	return new Promise((resolve) => {
		execFile(
			"git",
			[...SAFE_GIT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 15_000, windowsHide: true, encoding: "utf8" },
			(error, stdout) => {
				if (error) return resolve(null);
				resolve(stdout.split("\0").filter(Boolean).slice(0, LIMIT));
			},
		);
	});
}

async function walk(root: string): Promise<string[]> {
	const found: string[] = [];
	const queue: string[] = [""];
	while (queue.length > 0 && found.length < LIMIT) {
		const relative = queue.shift() ?? "";
		let entries;
		try {
			entries = await readdir(path.join(root, relative), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIP.has(entry.name)) queue.push(child);
			} else if (entry.isFile()) {
				found.push(child);
			}
		}
	}
	return found;
}

export async function listAllFiles(root: string): Promise<string[]> {
	return (await gitFiles(root)) ?? (await walk(root));
}
