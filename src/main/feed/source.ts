import { execFile, spawn, type ChildProcess } from "node:child_process";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FeedItem } from "../../shared/feed.ts";
import { htmlToText } from "./html.ts";
import { fetchPublic, hostRefusal, type FetchFn, type LookupFn } from "./net.ts";

export { htmlToText } from "./html.ts";
export { isPublicAddress } from "./net.ts";

/**
 * Reading a fed source in the main process, for a model that has no tools.
 * Everything it downloads lands in the job's temp folder or in memory.
 *
 * - video / video-file: the installed /watch plugin's watch.py, run with a
 *   fixed argv through execFile (never a shell); its report is the text.
 * - article: fetched here (public addresses only, capped), then cleaned by
 *   the defuddle CLI from a file when a real executable is installed, else
 *   by the linear HTML-to-text converter.
 * - pdf: downloaded (same checks) or read, capped, and returned as bytes
 *   for an engine that reads PDFs.
 * The job's abort signal reaches every process (whole tree killed) and
 * download. Every failure comes back as `{ ok: false, error }`; nothing throws.
 */

/** What the reader found: text, or for a PDF its bytes (text is then empty) — the model reads the PDF itself. */
export type SourceResult = { readonly ok: true; readonly text: string; readonly pdf?: Uint8Array } | { readonly ok: false; readonly error: string };
export type ExecResult = { readonly ok: boolean; readonly stdout: string; readonly stderr: string };
export type ExecFn = (
	file: string,
	args: readonly string[],
	options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<ExecResult>;

export type SourceDeps = {
	readonly exec: ExecFn;
	readonly fetch: FetchFn;
	/** Every address a host name resolves to. */
	readonly lookup: LookupFn;
	readonly python: () => string | null;
	readonly watchScript: () => string | null;
	readonly defuddle: () => string | null;
	/** The environment the child processes start from (without any Groq key). */
	readonly env: NodeJS.ProcessEnv;
};

const VIDEO_TIMEOUT_MS = 15 * 60_000;
const ARTICLE_TIMEOUT_MS = 60_000;
const PDF_TIMEOUT_MS = 5 * 60_000;
const MAX_TEXT = 120_000;
const MAX_ARTICLE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const SOURCE_HTML = "source.html";
const CANCELLED: SourceResult = { ok: false, error: "Cancelled." };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const cap = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[… cut at ${MAX_TEXT} characters]` : text);
const tail = (text: string): string => text.trim().slice(-2000);

/** Ends the process and everything it started (yt-dlp, ffmpeg under python). */
function killTree(child: ChildProcess): void {
	if (!child.pid) {
		child.kill();
		return;
	}
	if (process.platform === "win32") {
		execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill();
	}
}

/** Output kept per stream; a report past this is cut (read_source caps text far lower anyway). */
const MAX_OUTPUT = 16 * 1024 * 1024;

/** A child process with a fixed argv: no shell, hidden window, bounded output; a timeout or the signal kills the whole tree. */
export const execFileFn: ExecFn = (file, args, options) =>
	new Promise((resolve) => {
		if (options.signal?.aborted) {
			resolve({ ok: false, stdout: "", stderr: "Cancelled." });
			return;
		}
		let stopped: string | null = null;
		let stdout = "";
		let stderr = "";
		let settled = false;
		const onAbort = (): void => stop("Cancelled.");
		const finish = (ok: boolean, error?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ ok: ok && !stopped, stdout, stderr: stopped ?? error ?? stderr });
		};
		const child = spawn(file, [...args], {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			// Its own process group elsewhere, so the whole group can be signalled.
			detached: process.platform !== "win32",
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (stdout.length < MAX_OUTPUT) stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < MAX_OUTPUT) stderr += chunk;
		});
		child.on("error", (error) => finish(false, error.message));
		child.on("close", (code) => finish(code === 0, code === 0 ? undefined : stderr || `Exited with code ${code ?? "?"}.`));
		const stop = (why: string): void => {
			if (stopped) return;
			stopped = why;
			killTree(child);
		};
		const timer = setTimeout(() => stop(`Timed out after ${Math.round(options.timeoutMs / 60_000)} minutes.`), options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
	});

/** The job's signal and a timeout, whichever comes first. */
const within = (timeoutMs: number, signal?: AbortSignal): AbortSignal =>
	signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

export async function readSource(item: FeedItem, workDir: string, groqKey: string | null, deps: SourceDeps, signal?: AbortSignal): Promise<SourceResult> {
	if (signal?.aborted) return CANCELLED;
	try {
		switch (item.input) {
			case "video":
			case "video-file":
				return await readVideo(item.source, workDir, groqKey, deps, signal);
			case "article":
				return await readArticle(item.source, workDir, deps, signal);
			case "pdf":
				return await readPdf(item.source, deps, signal);
		}
	} catch (error) {
		return signal?.aborted ? CANCELLED : { ok: false, error: `Reading the source failed: ${messageOf(error)}` };
	}
}

async function readVideo(source: string, workDir: string, groqKey: string | null, deps: SourceDeps, signal?: AbortSignal): Promise<SourceResult> {
	const script = deps.watchScript();
	if (!script) return { ok: false, error: "The /watch plugin is not installed (no watch.py under ~/.claude/plugins/cache)." };
	const python = deps.python();
	if (!python) return { ok: false, error: "Python was not found on PATH; /watch needs it." };
	// A link gets the same host check as every download here before yt-dlp sees it
	// (yt-dlp then follows the site's own redirects; the window is one lookup wide, as for fetchPublic).
	if (/^https?:\/\//i.test(source)) {
		const refused = await hostRefusal(new URL(source), deps.lookup);
		if (refused) return { ok: false, error: refused };
		if (signal?.aborted) return CANCELLED;
	}
	const env: NodeJS.ProcessEnv = { ...deps.env, ...(groqKey ? { GROQ_API_KEY: groqKey } : {}) };
	// -I: isolated mode (no PYTHON* variables, no user site). -X utf8: piped stdout would otherwise be cp1252 on
	// Windows, and a title or transcript with an emoji or CJK text crashes watch.py (PYTHONUTF8 is ignored under -I).
	// "--" ends the options, so the source is never read as one.
	const result = await deps.exec(python, ["-I", "-X", "utf8", script, "--out-dir", workDir, "--", source], {
		cwd: workDir,
		env,
		timeoutMs: VIDEO_TIMEOUT_MS,
		...(signal ? { signal } : {}),
	});
	if (!result.ok) return { ok: false, error: `/watch failed: ${tail(result.stderr || result.stdout)}` };
	return { ok: true, text: cap(result.stdout) };
}

async function readArticle(url: string, workDir: string, deps: SourceDeps, signal?: AbortSignal): Promise<SourceResult> {
	const fetched = await fetchPublic(url, MAX_ARTICLE_BYTES, within(ARTICLE_TIMEOUT_MS, signal), deps);
	if (!fetched.ok) return fetched;
	const body = new TextDecoder("utf-8").decode(fetched.bytes);
	const isHtml = /html/i.test(fetched.type) || /^\s*</.test(body);

	// defuddle gets the page we fetched (as a file), never the URL: it fetches nothing itself.
	const defuddle = isHtml ? deps.defuddle() : null;
	if (defuddle) {
		const file = join(workDir, SOURCE_HTML);
		await writeFile(file, fetched.bytes);
		const result = await deps.exec(defuddle, ["parse", file, "--md"], {
			cwd: workDir,
			env: deps.env,
			timeoutMs: ARTICLE_TIMEOUT_MS,
			...(signal ? { signal } : {}),
		});
		if (result.ok && result.stdout.trim()) return { ok: true, text: cap(result.stdout) };
		if (signal?.aborted) return CANCELLED;
	}
	const text = isHtml ? htmlToText(body) : body;
	return text.trim() ? { ok: true, text: cap(text) } : { ok: false, error: "The page had no readable text." };
}

async function readPdf(source: string, deps: SourceDeps, signal?: AbortSignal): Promise<SourceResult> {
	if (/^https?:\/\//i.test(source)) {
		const fetched = await fetchPublic(source, MAX_PDF_BYTES, within(PDF_TIMEOUT_MS, signal), deps);
		if (!fetched.ok) return fetched;
		return isPdf(fetched.bytes) ? { ok: true, text: "", pdf: fetched.bytes } : { ok: false, error: "The link did not return a PDF." };
	}
	let info;
	try {
		info = await stat(source);
	} catch {
		return { ok: false, error: `The file ${source} was not found.` };
	}
	if (!info.isFile()) return { ok: false, error: `${source} is not a file.` };
	if (info.size > MAX_PDF_BYTES) return { ok: false, error: "The PDF is larger than 50 MB." };
	if (!(await startsLikePdf(source))) return { ok: false, error: `${source} is not a PDF.` };
	return { ok: true, text: "", pdf: await readFile(source) };
}

const isPdf = (bytes: Uint8Array): boolean => new TextDecoder("latin1").decode(bytes.subarray(0, 5)) === "%PDF-";

async function startsLikePdf(file: string): Promise<boolean> {
	const handle = await open(file, "r");
	try {
		const head = new Uint8Array(5);
		await handle.read(head, 0, 5, 0);
		return isPdf(head);
	} finally {
		await handle.close();
	}
}

/** watch.py of the highest installed /watch version: ~/.claude/plugins/cache/<market>/watch/<version>/scripts/watch.py. */
export function locateWatchScript(home: string): string | null {
	const cache = join(home, ".claude", "plugins", "cache");
	const found: { version: number[]; path: string }[] = [];
	for (const market of list(cache)) {
		for (const version of list(join(cache, market, "watch"))) {
			const script = join(cache, market, "watch", version, "scripts", "watch.py");
			if (isFile(script)) found.push({ version: version.split(".").map((part) => Number.parseInt(part, 10) || 0), path: script });
		}
	}
	found.sort((a, b) => compareVersions(b.version, a.version));
	return found[0]?.path ?? null;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function list(folder: string): string[] {
	try {
		return readdirSync(folder, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

/** A real Python on PATH. On Windows, python.exe outside WindowsApps (that one is the Store stub). */
export function locatePython(platform: NodeJS.Platform, pathEntries: readonly string[], exists: (file: string) => boolean): string | null {
	const windows = platform === "win32";
	const names = windows ? ["python.exe"] : ["python3", "python"];
	for (const name of names) {
		for (const entry of pathEntries) {
			if (windows && /[\\/]WindowsApps([\\/]|$)/i.test(entry)) continue;
			const candidate = windows ? `${entry.replace(/[\\/]+$/, "")}\\${name}` : `${entry.replace(/\/+$/, "")}/${name}`;
			if (exists(candidate)) return candidate;
		}
	}
	return null;
}

/** The defuddle CLI as a real executable (npm's .cmd shims cannot run without a shell, so they do not count). */
export function locateDefuddle(platform: NodeJS.Platform, pathEntries: readonly string[], exists: (file: string) => boolean): string | null {
	const name = platform === "win32" ? "defuddle.exe" : "defuddle";
	for (const entry of pathEntries) {
		const candidate = join(entry, name);
		if (exists(candidate)) return candidate;
	}
	return null;
}
