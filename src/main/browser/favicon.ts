/**
 * Tab icons. The app window only shows images that are its own or inline
 * (its CSP), and should never contact a host a page picked, so the icon is
 * fetched here, through the browser's own session, and handed over as a
 * small data: URL. Anything that is not a small raster or SVG image is dropped.
 */

const MAX_BYTES = 100_000;
const TIMEOUT_MS = 5000;
const TYPES = new Set(["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/gif", "image/jpeg", "image/webp", "image/svg+xml"]);

/** An inline icon the window may show as it is; null when it has to be fetched or is not an image. */
export function inlineIcon(url: string): string | null {
	const type = /^data:([^;,]+)[;,]/i.exec(url)?.[1]?.toLowerCase();
	return type && TYPES.has(type) && url.length <= MAX_BYTES * 2 ? url : null;
}

/** The image type to trust, from the response's header; null when it is not one of the allowed images. */
export function iconType(contentType: string | null): string | null {
	const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
	return TYPES.has(type) ? type : null;
}

type Fetcher = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

/** The icon at `url` as a data: URL, or null. Never throws. */
export async function fetchIcon(url: string, fetcher: Fetcher): Promise<string | null> {
	const inline = inlineIcon(url);
	if (inline) return inline;
	if (!/^https?:\/\//i.test(url) || url.length > 2048) return null;
	try {
		const response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		const type = iconType(response.headers.get("content-type"));
		if (!response.ok || !type) return null;
		const body = Buffer.from(await response.arrayBuffer());
		if (body.length === 0 || body.length > MAX_BYTES) return null;
		return `data:${type};base64,${body.toString("base64")}`;
	} catch {
		return null;
	}
}
