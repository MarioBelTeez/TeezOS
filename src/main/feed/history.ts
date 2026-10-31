import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { VaultSource } from "../../shared/feed-history.ts";
import { PROVENANCE } from "./secure-note.ts";

/**
 * Source notes in the vault that a feed job wrote: the frontmatter of the
 * notes under reference/sources/, nothing else read, with the count capped.
 * They fill the Feed view's History for jobs that are no longer in the
 * persisted list.
 */

/** Notes returned, newest first. */
export const MAX_SCANNED = 200;
/** Candidates looked into (newest by modified time) before the cap. */
const MAX_CANDIDATES = 600;
/** The head of a note read for its frontmatter. */
const HEAD_BYTES = 4096;
const MAX_FIELD = 500;

/** The `key: value` lines of the frontmatter in the head of a note, or null when it has none. */
function frontmatter(head: string): Map<string, string> | null {
	const text = head.replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) return null;
	const end = text.indexOf("\n---", 4);
	if (end < 0) return null;
	const fields = new Map<string, string>();
	for (const line of text.slice(4, end).split("\n")) {
		const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
		if (match && !fields.has(match[1] ?? "")) fields.set(match[1] ?? "", unquote((match[2] ?? "").trim()));
	}
	return fields;
}

function unquote(value: string): string {
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (typeof parsed === "string") return parsed;
		} catch {
			// Not a JSON string: keep it as written.
		}
	}
	return value.replace(/^'(.*)'$/, "$1");
}

const oneLine = (value: string | undefined): string => (value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_FIELD);

async function head(file: string): Promise<string | null> {
	let handle;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.alloc(HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function dateOf(value: string | undefined, fallback: number): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
	if (!match) return fallback;
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
	return Number.isFinite(date) ? date : fallback;
}

export async function scanSourceNotes(vault: string, limit: number = MAX_SCANNED): Promise<VaultSource[]> {
	const folder = join(vault, "reference", "sources");
	let entries;
	try {
		entries = await readdir(folder, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: { name: string; mtime: number }[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
		try {
			files.push({ name: entry.name, mtime: (await stat(join(folder, entry.name))).mtimeMs });
		} catch {
			// Gone since the listing.
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	const found: VaultSource[] = [];
	for (const file of files.slice(0, MAX_CANDIDATES)) {
		if (found.length >= limit) break;
		const text = await head(join(folder, file.name));
		const fields = text === null ? null : frontmatter(text);
		if (!fields || fields.get("provenance")?.trim() !== PROVENANCE) continue;
		found.push({
			path: `reference/sources/${file.name}`,
			title: file.name.replace(/\.md$/i, ""),
			date: dateOf(fields.get("date"), file.mtime),
			url: oneLine(fields.get("url")),
			kind: oneLine(fields.get("kind")),
		});
	}
	return found;
}

/** The url of a note frontmatter (JSON-quoted or plain), or null. */
function urlOf(text: string): string | null {
	const fields = frontmatter(text);
	const url = fields?.get("url");
	return url ? url.trim() : null;
}

/** Most notes looked into when asking whether a link is already filed. */
const MAX_LOOKUP = 3000;

/**
 * The Source note in reference/sources/ whose `url:` is `url` (vault-relative
 * path), or null. Heads only; the same link fed twice is found before any
 * model is asked.
 */
export async function findFiledSource(vault: string, url: string): Promise<string | null> {
	const folder = join(vault, "reference", "sources");
	let entries;
	try {
		entries = await readdir(folder, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries.slice(0, MAX_LOOKUP)) {
		if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
		const text = await head(join(folder, entry.name));
		if (text !== null && urlOf(text) === url) return `reference/sources/${entry.name}`;
	}
	return null;
}
