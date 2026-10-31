import type { FeedItem } from "./feed.ts";

/**
 * The Feed view's History: everything ingested, newest first. It joins the
 * persisted jobs (up to 200) with the notes found in the vault that a feed
 * job wrote (`provenance: feed-untrusted` under reference/sources/) and no
 * job lists. Pure; the main process does the scan, the window does the merge.
 */

/** A Source note found in the vault by its frontmatter. */
export type VaultSource = {
	/** Vault-relative, forward slashes. */
	readonly path: string;
	readonly title: string;
	/** Milliseconds: the frontmatter date, else the file's modified time. */
	readonly date: number;
	readonly url: string;
	readonly kind: string;
};

export type HistoryEntry = {
	readonly key: string;
	readonly date: number;
	readonly title: string;
	/** The link or path it came from; "" when unknown. */
	readonly source: string;
	readonly kind: string;
	/** Vault-relative notes it created. */
	readonly notes: readonly string[];
	/** The job, or null for a note found only in the vault. */
	readonly itemId: string | null;
};

/** Persisted jobs shown. */
export const MAX_HISTORY_ITEMS = 200;

const pathKey = (path: string): string => path.replace(/\\/g, "/").toLowerCase();
const kindOf = (item: FeedItem): string => (item.input === "video-file" ? "video" : item.input);

export function mergeHistory(items: readonly FeedItem[], scanned: readonly VaultSource[]): HistoryEntry[] {
	const finished = items
		.filter((item) => item.status === "done")
		.map<HistoryEntry>((item) => ({
			key: `job:${item.id}`,
			date: item.finishedAt ?? item.createdAt,
			title: item.title || item.source,
			source: item.source,
			kind: kindOf(item),
			notes: item.changed,
			itemId: item.id,
		}))
		.sort((a, b) => b.date - a.date)
		.slice(0, MAX_HISTORY_ITEMS);
	const listed = new Set(items.flatMap((item) => item.changed.map(pathKey)));
	const found = scanned
		.filter((note) => !listed.has(pathKey(note.path)))
		.map<HistoryEntry>((note) => ({ key: `note:${pathKey(note.path)}`, date: note.date, title: note.title, source: note.url, kind: note.kind, notes: [note.path], itemId: null }));
	return [...finished, ...found].sort((a, b) => b.date - a.date);
}

const day = (ms: number): string => {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Entries that match every word of `query` in their title, source, kind, notes or date. */
export function filterHistory(entries: readonly HistoryEntry[], query: string): readonly HistoryEntry[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return entries;
	return entries.filter((entry) => {
		const haystack = [entry.title, entry.source, entry.kind, ...entry.notes, day(entry.date)].join("\n").toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}
