import { isBag } from "./normalize.ts";

/**
 * Feed the Brain: a video, an article or a PDF goes in, vault notes come out.
 *
 * Each source is a job in a queue that runs one at a time. This module is the
 * queue's pure half — what a source is, how a job's state moves and how the
 * persisted file is read back. The main process (feed/runner.ts) drives it;
 * the window only shows it.
 */

export type FeedKind = "auto" | "source" | "concept" | "skill";
export type FeedInputKind = "video" | "article" | "pdf" | "video-file";
export type FeedStatus = "queued" | "reading" | "writing" | "done" | "failed" | "cancelled";
export type FeedItem = {
	readonly id: string;
	readonly source: string;
	readonly input: FeedInputKind;
	readonly kind: FeedKind;
	readonly note: string;
	readonly status: FeedStatus;
	readonly createdAt: number;
	/** When the run began; null while queued (and for jobs that never started). */
	readonly startedAt: number | null;
	readonly finishedAt: number | null;
	readonly title: string;
	readonly log: readonly string[];
	readonly changed: readonly string[];
	readonly drafts: readonly string[];
	readonly error: string | null;
};

export type FeedAction =
	| { type: "start"; id: string; now?: number }
	| { type: "phase"; id: string; status: "reading" | "writing" }
	| { type: "log"; id: string; line: string }
	| { type: "title"; id: string; title: string }
	| { type: "finish"; id: string; changed: readonly string[]; drafts: readonly string[]; now: number }
	| { type: "fail"; id: string; error: string; now: number }
	| { type: "cancel"; id: string; now: number }
	/** Notes written by a job, recorded whatever state it ended up in (a cancel can land during the write). */
	| { type: "wrote"; id: string; changed: readonly string[]; drafts: readonly string[] }
	| { type: "retry"; id: string }
	| { type: "remove"; id: string };

export const FEED_KINDS: readonly FeedKind[] = ["auto", "source", "concept", "skill"];
const INPUT_KINDS: readonly FeedInputKind[] = ["video", "article", "pdf", "video-file"];
const STATUSES: readonly FeedStatus[] = ["queued", "reading", "writing", "done", "failed", "cancelled"];

/** Longest link or path accepted. */
export const MAX_FEED_SOURCE = 2048;
/** Longest "why I'm saving this" note. */
export const MAX_FEED_NOTE = 1000;
/** Log lines kept per job; the oldest go first. */
export const MAX_FEED_LOG = 400;
/** Jobs kept in the queue file. */
export const MAX_FEED_ITEMS = 200;
const MAX_TITLE = 200;
const MAX_LINE = 2000;

/** Hosts whose pages are videos yt-dlp reads (subdomains included). */
const VIDEO_HOSTS: readonly string[] = ["youtube.com", "youtu.be", "vimeo.com", "tiktok.com", "x.com", "twitter.com", "instagram.com", "twitch.tv"];
const VIDEO_URL_EXT = /\.(mp4|webm|mov)$/i;
const VIDEO_FILE_EXT = /\.(mp4|mkv|mov|webm)$/i;
const PDF_EXT = /\.pdf$/i;
/** Characters that end or expand a double-quoted shell argument; a source never carries them. */
const SHELL_UNSAFE = /[`"$]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

const ID = /^[A-Za-z0-9-]{1,64}$/;

/** A job id as the main process makes them; anything else from the window is refused. */
export function isFeedId(value: unknown): value is string {
	return typeof value === "string" && ID.test(value);
}

export function isFeedKind(value: unknown): value is FeedKind {
	return typeof value === "string" && (FEED_KINDS as readonly string[]).includes(value);
}

function isVideoHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return VIDEO_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

const isWebLink = (text: string): boolean => /^https?:\/\//i.test(text);
/**
 * A drive path or a POSIX absolute path. Two leading separators of either
 * kind (`//host`, `/\host`) are what Windows resolves to a network share, so
 * those are refused: the same test as `path.win32.resolve(text).startsWith("\\\\")`,
 * without Node's path (the window uses this module too).
 */
const isLocalPath = (text: string): boolean => /^[A-Za-z]:[\\/]/.test(text) || (text.startsWith("/") && !/^[\\/]{2}/.test(text));

/**
 * The one spelling of a source that is stored and put into the prompt, or
 * null when it is not acceptable. Links become their parsed `href`; a path
 * pasted with Explorer's "Copy as path" loses its quotes. Control characters,
 * backticks, double quotes and `$` are refused outright, so the source can
 * never close or expand the quoted argument it ends up in.
 * Local files are drive paths (C:\ or C:/) or POSIX absolute paths; network
 * shares (\\server, //server) and other URL schemes are refused.
 */
export function normalizeSource(source: string): string | null {
	let text = source.trim();
	const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
	if (quoted) text = (quoted[2] ?? "").trim();
	if (text.length === 0 || text.length > MAX_FEED_SOURCE || CONTROL.test(text) || SHELL_UNSAFE.test(text)) return null;

	if (isWebLink(text)) {
		let url: URL;
		try {
			url = new URL(text);
		} catch {
			return null;
		}
		if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
		const href = url.href;
		return href.length > MAX_FEED_SOURCE || SHELL_UNSAFE.test(href) || CONTROL.test(href) ? null : href;
	}
	return isLocalPath(text) ? text : null;
}

/** What a pasted link or dropped path is, or null when the feed cannot read it. */
export function detectInput(source: string): FeedInputKind | null {
	const text = normalizeSource(source);
	if (!text) return null;

	if (isWebLink(text)) {
		const url = new URL(text);
		if (PDF_EXT.test(url.pathname)) return "pdf";
		if (VIDEO_URL_EXT.test(url.pathname) || isVideoHost(url.hostname)) return "video";
		return "article";
	}
	if (PDF_EXT.test(text)) return "pdf";
	if (VIDEO_FILE_EXT.test(text)) return "video-file";
	return null;
}

export function newItem(id: string, source: string, kind: FeedKind, note: string, now: number): FeedItem | null {
	const normalized = normalizeSource(source);
	const input = normalized ? detectInput(normalized) : null;
	if (!normalized || !input || !isFeedKind(kind) || !isFeedId(id)) return null;
	return {
		id,
		source: normalized,
		input,
		kind,
		note: cleanNote(note),
		status: "queued",
		createdAt: now,
		startedAt: null,
		finishedAt: null,
		title: "",
		log: [],
		changed: [],
		drafts: [],
		error: null,
	};
}

function cleanNote(note: string): string {
	return note.replace(CONTROL_BUT_NEWLINE, " ").trim().slice(0, MAX_FEED_NOTE);
}

function cleanLine(line: string): string {
	return line.replace(CONTROL_ALL, " ").slice(0, MAX_LINE);
}

const isRunning = (item: FeedItem): boolean => item.status === "reading" || item.status === "writing";

function update(items: readonly FeedItem[], id: string, change: (item: FeedItem) => FeedItem): FeedItem[] {
	return items.map((item) => (item.id === id ? change(item) : item));
}

export function reduceFeed(items: readonly FeedItem[], action: FeedAction): FeedItem[] {
	switch (action.type) {
		case "start":
			return update(items, action.id, (item) =>
				item.status === "queued" ? { ...item, status: "reading", startedAt: action.now ?? item.startedAt } : item,
			);
		case "phase":
			return update(items, action.id, (item) => (isRunning(item) ? { ...item, status: action.status } : item));
		case "log":
			return update(items, action.id, (item) => ({ ...item, log: [...item.log, cleanLine(action.line)].slice(-MAX_FEED_LOG) }));
		case "title":
			return update(items, action.id, (item) => ({ ...item, title: action.title.replace(CONTROL_ALL, " ").trim().slice(0, MAX_TITLE) }));
		case "finish":
			return update(items, action.id, (item) =>
				isRunning(item) ? { ...item, status: "done", changed: [...action.changed], drafts: [...action.drafts], finishedAt: action.now, error: null } : item,
			);
		case "fail":
			return update(items, action.id, (item) =>
				isRunning(item) || item.status === "queued" ? { ...item, status: "failed", error: action.error, finishedAt: action.now } : item,
			);
		case "wrote":
			return update(items, action.id, (item) => ({ ...item, changed: [...action.changed], drafts: [...action.drafts] }));
		case "cancel":
			return update(items, action.id, (item) =>
				isRunning(item) || item.status === "queued" ? { ...item, status: "cancelled", finishedAt: action.now } : item,
			);
		case "retry":
			return update(items, action.id, (item) =>
				item.status === "failed" || item.status === "cancelled"
					? { ...item, status: "queued", log: [], error: null, startedAt: null, finishedAt: null, changed: [], drafts: [] }
					: item,
			);
		case "remove":
			return items.filter((item) => item.id !== action.id);
	}
}

/** The oldest queued job; none while another one is running. */
export function nextQueued(items: readonly FeedItem[]): FeedItem | undefined {
	if (items.some(isRunning)) return undefined;
	let oldest: FeedItem | undefined;
	for (const item of items) {
		if (item.status === "queued" && (!oldest || item.createdAt < oldest.createdAt)) oldest = item;
	}
	return oldest;
}

const strings = (value: unknown, max: number): string[] =>
	Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(-max) : [];

const time = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

function normalizeItem(raw: unknown): FeedItem | null {
	if (!isBag(raw)) return null;
	const { id, source, input, kind, status } = raw;
	const normalized = typeof source === "string" ? normalizeSource(source) : null;
	if (!isFeedId(id) || !normalized || !detectInput(normalized)) return null;
	if (typeof input !== "string" || !(INPUT_KINDS as readonly string[]).includes(input)) return null;
	if (!isFeedKind(kind) || typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) return null;
	const createdAt = time(raw["createdAt"]);
	if (createdAt === null) return null;
	const interrupted = status === "reading" || status === "writing";
	return {
		id,
		source: normalized,
		input: input as FeedInputKind,
		kind,
		note: typeof raw["note"] === "string" ? cleanNote(raw["note"]) : "",
		status: interrupted ? "failed" : (status as FeedStatus),
		createdAt,
		startedAt: time(raw["startedAt"]),
		finishedAt: time(raw["finishedAt"]),
		title: typeof raw["title"] === "string" ? raw["title"].replace(CONTROL_ALL, " ").trim().slice(0, MAX_TITLE) : "",
		log: strings(raw["log"], MAX_FEED_LOG).map(cleanLine),
		changed: strings(raw["changed"], 1000),
		drafts: strings(raw["drafts"], 100),
		error: interrupted ? "TeezOS closed during the run" : typeof raw["error"] === "string" ? raw["error"] : null,
	};
}

/** The persisted queue; a job that was running when the app closed comes back failed. */
export function normalizeFeed(raw: unknown): FeedItem[] {
	if (!Array.isArray(raw)) return [];
	const items = raw.map(normalizeItem).filter((item): item is FeedItem => item !== null);
	const seen = new Set<string>();
	return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true))).slice(-MAX_FEED_ITEMS);
}

/** Longest Groq key accepted. */
export const MAX_GROQ_KEY = 200;

/** A Groq API key as Groq issues them: `gsk_` and printable characters, no spaces. */
export function isGroqKey(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_GROQ_KEY && /^gsk_[\x21-\x7e]+$/.test(value);
}
