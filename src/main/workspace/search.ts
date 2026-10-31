import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { listAllFiles } from "./index.ts";
import { SAFE_GIT } from "./git.ts";
import { resolveInsideReal } from "./guard.ts";

/**
 * Search inside the files of a workspace. `git grep` where there is a
 * repository (it skips ignored and binary files and is fast on large trees),
 * a plain scan elsewhere. Results are capped so a one-letter query cannot
 * flood the window.
 */

export type SearchHit = { readonly path: string; readonly line: number; readonly text: string };
export type SearchOptions = { readonly caseSensitive: boolean; readonly regex: boolean };

const MAX_HITS = 800;
const MAX_SCAN_BYTES = 1024 * 1024;

function gitGrep(root: string, query: string, options: SearchOptions): Promise<SearchHit[] | null> {
	const args = [
		...SAFE_GIT,
		"grep",
		"-n",
		"-I",
		"--no-color",
		"--untracked",
		"-z",
		options.regex ? "-E" : "-F",
		...(options.caseSensitive ? [] : ["-i"]),
		"-e",
		query,
	];
	return new Promise((resolve) => {
		execFile("git", args, { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 20_000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
			// Exit code 1 means "no match", which is an answer, not a failure.
			if (error && (error as { code?: unknown }).code !== 1) return resolve(null);
			const hits: SearchHit[] = [];
			for (const record of stdout.split("\n")) {
				if (!record) continue;
				// With -z: path NUL line NUL text
				const [file, line, ...rest] = record.split("\0");
				if (!file || !line) continue;
				hits.push({ path: file, line: Number(line), text: rest.join("\0").slice(0, 300) });
				if (hits.length >= MAX_HITS) break;
			}
			resolve(hits);
		});
	});
}

async function scan(root: string, query: string, options: SearchOptions): Promise<SearchHit[]> {
	let matcher: (line: string) => boolean;
	if (options.regex) {
		let pattern: RegExp;
		try {
			pattern = new RegExp(query, options.caseSensitive ? "" : "i");
		} catch {
			return [];
		}
		matcher = (line) => pattern.test(line);
	} else {
		const needle = options.caseSensitive ? query : query.toLowerCase();
		matcher = (line) => (options.caseSensitive ? line : line.toLowerCase()).includes(needle);
	}

	const hits: SearchHit[] = [];
	for (const file of await listAllFiles(root)) {
		// git lists symlinks too; one pointing at ~/.ssh must not be read.
		const guarded = resolveInsideReal(root, file);
		if (!guarded.ok) continue;
		const full = guarded.path;
		try {
			if ((await stat(full)).size > MAX_SCAN_BYTES) continue;
			const data = await readFile(full);
			if (data.subarray(0, 8000).includes(0)) continue;
			const lines = data.toString("utf8").split(/\r?\n/);
			for (let i = 0; i < lines.length; i += 1) {
				const text = lines[i] ?? "";
				if (!matcher(text)) continue;
				hits.push({ path: file, line: i + 1, text: text.slice(0, 300) });
				if (hits.length >= MAX_HITS) return hits;
			}
		} catch {
			// unreadable file: skip it
		}
	}
	return hits;
}

export async function searchWorkspace(root: string, query: string, options: SearchOptions): Promise<SearchHit[]> {
	if (!query) return [];
	return (await gitGrep(root, query, options)) ?? (await scan(root, query, options));
}
