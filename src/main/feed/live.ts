import { mkdir, rm } from "node:fs/promises";
import { readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { isFeedId } from "../../shared/feed.ts";
import { execFileFn, locateDefuddle, locatePython, locateWatchScript, readSource, type SourceDeps } from "./source.ts";
import type { FeedRunnerDeps } from "./runner.ts";

/**
 * The real versions of the runner's source-side dependencies: the job's
 * temp folder and the reader's processes and network.
 */

const PREFIX = "teezai-feed-";
const JOB_FOLDER = /^teezai-feed-[A-Za-z0-9-]{1,64}$/;
/** A leftover job folder is swept only once it is this old: a younger one may be another TeezAI's running job. */
const SWEEP_AGE_MS = 24 * 3600_000;

function realOr(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

/**
 * `<base>/teezai-feed-<id>` per job: made empty at the start, removed at the
 * end. The path handed out is the real one (links and 8.3 names resolved), so
 * the guard's read check matches the paths the job is given. `sweep` clears
 * day-old ones a run left behind when TeezAI quit during it.
 */
export function jobFolders(base: string, now: () => number = Date.now): FeedRunnerDeps["workDir"] & { readonly sweep: () => void } {
	const isJobFolder = (dir: string): boolean => {
		const parent = resolve(dirname(dir));
		return (parent === resolve(base) || parent === realOr(base)) && JOB_FOLDER.test(basename(dir));
	};
	return {
		create: async (id) => {
			if (!isFeedId(id)) throw new Error("Not a job id.");
			const dir = join(base, `${PREFIX}${id}`);
			await rm(dir, { recursive: true, force: true });
			await mkdir(dir, { recursive: true });
			return realpathSync.native(dir);
		},
		remove: async (dir) => {
			if (isJobFolder(dir)) await rm(dir, { recursive: true, force: true });
		},
		sweep: () => {
			let names: string[] = [];
			try {
				names = readdirSync(base);
			} catch {
				return;
			}
			for (const name of names) {
				if (!JOB_FOLDER.test(name)) continue;
				const dir = join(base, name);
				try {
					if (now() - statSync(dir).mtimeMs > SWEEP_AGE_MS) rmSync(dir, { recursive: true, force: true });
				} catch {
					// Gone already, or unreadable: leave it.
				}
			}
		},
	};
}

function exists(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * The reader as wired in the app: execFile, global fetch, the tools found on this computer.
 * `watchScript` overrides where watch.py is (the phone server's installed copy); by default
 * the newest copy in the /watch plugin's cache.
 */
export function liveReadSource(options: { readonly watchScript?: string } = {}): FeedRunnerDeps["readSource"] {
	const pathEntries = (): string[] => (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
	const deps: SourceDeps = {
		exec: execFileFn,
		fetch: (url, init) => fetch(url, init),
		lookup: async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address),
		python: () => locatePython(process.platform, pathEntries(), exists),
		watchScript: () => (options.watchScript ? (exists(options.watchScript) ? options.watchScript : null) : locateWatchScript(homedir())),
		defuddle: () => locateDefuddle(process.platform, pathEntries(), exists),
		env: process.env,
	};
	return (item, workDir, groqKey, signal) => readSource(item, workDir, groqKey, deps, signal);
}
