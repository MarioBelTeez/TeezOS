import type { FeedKind, FeedStatus } from "../../../src/shared/feed.ts";

/** A pasted link goes as `url`, anything else as `text`. */
export function feedBody(input: string, kind: FeedKind): { url: string; kind: FeedKind } | { text: string; kind: FeedKind } {
	const value = input.trim();
	if (/^https?:\/\/\S+$/i.test(value)) return { url: value, kind };
	return { text: value, kind };
}

const WORKING: ReadonlySet<FeedStatus> = new Set<FeedStatus>(["queued", "reading", "writing"]);

/** True while any item still waits or is being read or written: the list then polls. */
export function feedBusy(items: readonly { readonly status: FeedStatus }[]): boolean {
	return items.some((item) => WORKING.has(item.status));
}
