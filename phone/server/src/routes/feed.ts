import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FeedRunner, type FeedRunnerDeps } from "../../../../src/main/feed/runner.ts";
import { findFiledSource } from "../../../../src/main/feed/history.ts";
import { listConceptTitles, writeNotes } from "../../../../src/main/feed/writer.ts";
import { isFeedKind, MAX_FEED_SOURCE, normalizeFeed, type FeedItem, type FeedKind } from "../../../../src/shared/feed.ts";
import type { GitSync } from "../git-sync.ts";
import { HttpError, readJsonBody, type Route } from "../http.ts";

/**
 * Phone Feed: the desktop pipeline (read the source, ask a model that has no
 * tools, validate its JSON, write notes) in new-files-only mode, then commit
 * the written paths and push. Existing concept notes are never touched: the
 * writer lists the additions in the new Source note instead.
 */

const FEED_FILE = "feed.json";
const LIST_LIMIT = 30;
/** Longest pasted text accepted (the model reads at most this much anyway). */
const MAX_TEXT_CHARS = 120_000;
const COMMIT_TITLE_CHARS = 80;
/** Shared text has no link, so it gets a stable pseudo-link: the same text twice is the same source. */
const TEXT_SOURCE_PREFIX = "https://shared-text.invalid/";
const TEXT_LOST = "The shared text was lost when the service restarted. Share it again.";
const PATH = "/api/feed";

export type FeedRouteDeps = {
	readonly vault: string;
	readonly dataDir: string;
	readonly sync: GitSync;
	readonly readSource: FeedRunnerDeps["readSource"];
	readonly complete: FeedRunnerDeps["complete"];
	readonly workDir: FeedRunnerDeps["workDir"];
	readonly groqKey: () => string | null;
	readonly now: () => number;
};

const record = (body: unknown): Record<string, unknown> => (typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {});

function readQueue(file: string): FeedItem[] {
	if (!existsSync(file)) return [];
	try {
		return normalizeFeed(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return [];
	}
}

/** Atomic: a temp file, then a rename. */
function writeQueue(file: string, items: readonly FeedItem[]): void {
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		const temp = `${file}.tmp`;
		writeFileSync(temp, JSON.stringify(items), "utf8");
		renameSync(temp, file);
	} catch (error) {
		console.error("phone: could not save the feed queue", error);
	}
}

type Request = { source: string; kind: FeedKind; text: string | null; note: string };

function parseRequest(body: unknown): Request {
	const { url, text, kind = "auto", note = "" } = record(body);
	if ((url === undefined) === (text === undefined)) throw new HttpError(400, "send exactly one of url or text");
	if (!isFeedKind(kind)) throw new HttpError(400, "unknown kind");
	const cleanNote = typeof note === "string" ? note.trim().slice(0, 2000) : "";
	if (text !== undefined) {
		const clean = typeof text === "string" ? text.trim() : "";
		if (clean.length === 0) throw new HttpError(400, "text is required");
		if (clean.length > MAX_TEXT_CHARS) throw new HttpError(400, `text is over ${MAX_TEXT_CHARS} characters`);
		return { source: `${TEXT_SOURCE_PREFIX}${createHash("sha256").update(clean).digest("hex").slice(0, 16)}`, kind, text: clean, note: cleanNote };
	}
	if (typeof url !== "string" || url.length === 0 || url.length > MAX_FEED_SOURCE) throw new HttpError(400, `url must be at most ${MAX_FEED_SOURCE} characters`);
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		throw new HttpError(400, "url is not a valid link");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new HttpError(400, "url must be http or https");
	return { source: parsed.href, kind, text: null, note: cleanNote };
}

const summary = (item: FeedItem) => ({
	id: item.id,
	source: item.source.startsWith(TEXT_SOURCE_PREFIX) ? "shared text" : item.source,
	status: item.status,
	title: item.title,
	error: item.error,
	createdAt: item.createdAt,
});

export function feedRoute(deps: FeedRouteDeps): Route {
	const file = path.join(deps.dataDir, FEED_FILE);
	/** Pasted texts waiting to be read, by their pseudo-link. Not persisted: a restart loses queued text. */
	const texts = new Map<string, string>();

	const readSource: FeedRunnerDeps["readSource"] = async (item, workDir, groqKey, signal) => {
		if (!item.source.startsWith(TEXT_SOURCE_PREFIX)) return deps.readSource(item, workDir, groqKey, signal);
		const text = texts.get(item.source);
		return text === undefined ? { ok: false, error: TEXT_LOST } : { ok: true, text };
	};

	/**
	 * New files only, then a local commit of exactly the files written; the
	 * push runs in the background (the retry tick covers a failure), so the
	 * item never waits for GitHub. Written and committed under `writing`, so
	 * the leftover-notes recovery never commits a half-written set.
	 */
	const write: FeedRunnerDeps["write"] = async (vault, item, extraction, now) => {
		const done = await deps.sync.writing(async () => {
			const result = await writeNotes(vault, item, extraction, now, { appendExisting: false });
			if (!result.ok || result.changed.length === 0) return { result, committed: false };
			const title = result.title.slice(0, COMMIT_TITLE_CHARS);
			const outcome = await deps.sync.commit(result.changed, `feed ${title}`);
			if (outcome.error !== undefined) return { result: { ...result, warnings: [...result.warnings, "Saved in the vault, but the commit failed; it will be retried."] }, committed: false };
			return { result, committed: true };
		});
		if (done.committed) deps.sync.pushSoon().catch((error: unknown) => console.error("phone: background push failed", error));
		return done.result;
	};

	const runner = new FeedRunner({
		vault: () => deps.vault,
		groqKey: deps.groqKey,
		readSource,
		workDir: deps.workDir,
		filed: (vault, item) => findFiledSource(vault, item.source),
		conceptTitles: listConceptTitles,
		complete: deps.complete,
		write,
		save: (items) => writeQueue(file, items),
		emit: () => undefined,
		now: deps.now,
	});
	runner.load(readQueue(file));

	return async (req, url) => {
		if (url.pathname !== PATH) return null;
		if (req.method === "GET") {
			const items = [...runner.items()].reverse().slice(0, LIST_LIMIT);
			return { status: 200, body: { items: items.map(summary) } };
		}
		if (req.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
		const request = parseRequest(await readJsonBody(req));
		if (request.text !== null) texts.set(request.source, request.text);
		const note = request.note || (request.text === null ? "" : "Shared as text from the phone.");
		const added = runner.add(request.source, request.kind, note);
		if (!("id" in added)) throw new HttpError(added.error === "That is already in the queue." ? 409 : 400, added.error);
		return { status: 202, body: { id: added.id } };
	};
}
