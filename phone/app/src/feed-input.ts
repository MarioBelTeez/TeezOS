import type { FeedKind, FeedStatus } from "../../../src/shared/feed.ts";

/** A pasted link goes as `url`, anything else as `text`. Optional `note` adds context. */
export function feedBody(
	input: string,
	kind: FeedKind,
	note = "",
): { url: string; kind: FeedKind; note?: string } | { text: string; kind: FeedKind; note?: string } {
	const value = input.trim();
	const cleanNote = note.trim();
	const extra = cleanNote.length > 0 ? { note: cleanNote } : {};
	if (/^https?:\/\/\S+$/i.test(value)) return { url: value, kind, ...extra };
	return { text: value, kind, ...extra };
}

const WORKING: ReadonlySet<FeedStatus> = new Set<FeedStatus>(["queued", "reading", "writing"]);

/** True while any item still waits or is being read or written: the list then polls. */
export function feedBusy(items: readonly { readonly status: FeedStatus }[]): boolean {
	return items.some((item) => WORKING.has(item.status));
}
