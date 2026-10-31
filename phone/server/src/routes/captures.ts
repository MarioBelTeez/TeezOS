import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitSync } from "../git-sync.ts";
import { HttpError, readJsonBody, type Route } from "../http.ts";
import { captureNote, MAX_CAPTURE_CHARS, writeNewNote, type CaptureProvenance } from "../vault-writer.ts";

const LIST_LIMIT = 20;
const TITLE_CHARS = 80;
const COMMIT_WORDS = 6;
const LOG_FILE = "captures.json";
/** The folders the service writes notes into (captures, feed sources, feed concepts): recovery commits what is left there. */
export const SERVICE_FOLDERS = ["thinking", "reference/sources", "brain/concepts"] as const;

type LogEntry = { path: string; title: string; date: string; committed: boolean; synced: boolean };
/** `synced` is true only when the push had already happened; the push runs in the background. */
export type SavedCapture = { path: string; synced: boolean };
export type SaveOptions = { readonly provenance?: CaptureProvenance };
export type SaveCapture = (text: string, links: readonly string[], options?: SaveOptions) => Promise<SavedCapture>;
type Deps = { vault: string; dataDir: string; sync: GitSync; now: () => number };

const pad = (value: number): string => String(value).padStart(2, "0");
/** YYYY-MM-DD in local time, the same clock the file name uses. */
function localDate(now: number): string {
	const when = new Date(now);
	return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

function titleOf(text: string): string {
	return text.trim().split("\n")[0]!.replace(/\s+/g, " ").slice(0, TITLE_CHARS);
}

function parseBody(body: unknown): { text: string; links: string[] } {
	const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
	const text = typeof record["text"] === "string" ? record["text"].trim() : "";
	if (text.length === 0) throw new HttpError(400, "text is required");
	if (text.length > MAX_CAPTURE_CHARS) throw new HttpError(400, `text is over ${MAX_CAPTURE_CHARS} characters`);
	const raw = record["links"];
	if (raw !== undefined && (!Array.isArray(raw) || raw.some((link) => typeof link !== "string"))) throw new HttpError(400, "links must be strings");
	return { text, links: (raw as string[] | undefined) ?? [] };
}

/** Phone captures: new notes in the vault clone, committed and pushed, with a small log of their own. */
export function createCaptures(deps: Deps) {
	const logPath = path.join(deps.dataDir, LOG_FILE);
	let chain: Promise<unknown> = Promise.resolve();
	/** Serialises log read-modify-write so concurrent captures never lose entries. */
	const locked = <T>(task: () => Promise<T>): Promise<T> => {
		const run = chain.then(task, task);
		chain = run.catch(() => undefined);
		return run;
	};

	async function readLog(): Promise<LogEntry[]> {
		let raw: string;
		try {
			raw = await readFile(logPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed as LogEntry[];
		} catch {
			// falls through to the corrupt handling below
		}
		const aside = `${logPath}.corrupt-${deps.now()}`;
		console.error(`phone: captures log is corrupt, kept as ${aside}`);
		await rename(logPath, aside);
		return [];
	}

	async function writeLog(entries: readonly LogEntry[]): Promise<void> {
		await mkdir(deps.dataDir, { recursive: true });
		const temp = `${logPath}.tmp`;
		await writeFile(temp, JSON.stringify(entries), "utf8");
		await rename(temp, logPath);
	}

	const update = (change: (entries: LogEntry[]) => LogEntry[]): Promise<void> => locked(async () => writeLog(change(await readLog())));

	const commitMessage = (title: string): string => `capture ${title.split(" ").slice(0, COMMIT_WORDS).join(" ")}`;

	const markPushed = (): Promise<void> => update((all) => all.map((e) => (e.committed ? { ...e, synced: true } : e)));
	const reportPush = (error: unknown): void => console.error("phone: background push failed", error);

	/** Pushes in the background; once it worked, every committed capture is synced. A failure is the retry tick's. */
	function pushInBackground(): void {
		deps.sync
			.pushSoon()
			.then((pushed) => (pushed ? markPushed() : undefined))
			.catch(reportPush);
	}

	/**
	 * Writes the note, logs it (not committed yet: a crash after this leaves a
	 * logged file that recovery commits), commits it locally and answers. The
	 * push runs in the background, so a slow or down GitHub never holds up the
	 * request (Safari gives up after about a minute, and a retry would save twice).
	 */
	async function saveCapture(text: string, links: readonly string[], options: SaveOptions = {}): Promise<SavedCapture> {
		const { text: clean } = parseBody({ text });
		const note = captureNote(clean, deps.now(), links, options.provenance);
		const title = titleOf(clean);
		const date = localDate(deps.now());
		const saved = await deps.sync.writing(async () => {
			const written = await writeNewNote(deps.vault, note.rel, note.content);
			if (!written.ok) throw new HttpError(500, written.error);
			await update((entries) => [...entries, { path: written.rel, title, date, committed: false, synced: false }]);
			const outcome = await deps.sync.commit([written.rel], commitMessage(title));
			if (outcome.error === undefined) await update((all) => all.map((e) => (e.path === written.rel ? { ...e, committed: true } : e)));
			return { rel: written.rel, committed: outcome.error === undefined };
		});
		if (saved.committed) pushInBackground();
		return { path: saved.rel, synced: false };
	}

	let running = false;
	/** One retry pass at a time: a tick that finds one still running is skipped. */
	async function exclusive(task: () => Promise<void>): Promise<void> {
		if (running) return;
		running = true;
		try {
			await task();
		} finally {
			running = false;
		}
	}

	/**
	 * Commits every note the service left uncommitted in its folders (a
	 * restart between writing and committing: captures, logged or not, and
	 * feed notes, which have no log), then marks the logged captures committed.
	 * Returns whether anything was committed.
	 */
	async function sweep(): Promise<boolean> {
		const result = await deps.sync.recoverUncommitted(SERVICE_FOLDERS);
		if (result.error !== undefined) {
			console.error("phone: could not commit leftover notes", result.error);
			return false;
		}
		if (result.committed > 0) {
			console.log(`phone: committed ${result.committed} leftover notes`);
			await update((all) => all.map((e) => (e.committed || !existsSync(path.join(deps.vault, e.path)) ? e : { ...e, committed: true })));
		}
		return result.committed > 0;
	}

	/** Startup: commits what an earlier run left uncommitted, then pushes it in the background. */
	const recover = (): Promise<void> =>
		exclusive(async () => {
			if (await sweep()) pushInBackground();
		});

	/** Interval: the same sweep, then GitSync retries its own failed commits and the push; when that fully succeeds, the logged captures are committed and synced. */
	const retry = (): Promise<void> =>
		exclusive(async () => {
			await sweep();
			if (!(await deps.sync.retryPending())) return;
			await update((all) => all.map((e) => (e.committed || existsSync(path.join(deps.vault, e.path)) ? { ...e, committed: true, synced: true } : e)));
		});

	const route: Route = async (req, url) => {
		if (url.pathname !== "/api/captures") return null;
		if (req.method === "GET") {
			const entries = await locked(readLog);
			return { status: 200, body: entries.slice(-LIST_LIMIT).map(({ path: p, title, date, synced }) => ({ path: p, title, date, synced })) };
		}
		if (req.method === "POST") {
			const { text, links } = parseBody(await readJsonBody(req));
			return { status: 201, body: await saveCapture(text, links) };
		}
		return { status: 405, body: { error: "method not allowed" } };
	};

	return { route, saveCapture, recover, retry };
}

export function capturesRoute(deps: Deps): Route {
	return createCaptures(deps).route;
}
