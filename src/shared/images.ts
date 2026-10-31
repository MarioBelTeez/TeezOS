/**
 * Images pasted into a chat. The window shrinks them before sending (see
 * ChatPanel); the main process checks them again here — count, size, and the
 * type from the bytes themselves — before any agent sees them.
 */

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type ChatImage = { readonly mediaType: ImageType; readonly data: string };

export const MAX_IMAGES = 5;
/**
 * The API's per-image limit, which it measures on the base64 text
 * ("image exceeds 5 MB maximum: … > 5242880 bytes"), so about 3.9 MB of file.
 * Five of them also stay under its 32 MB request cap.
 */
export const MAX_BASE64 = 5_242_880;
/** Claude scales anything with a longer edge down to about this anyway. */
export const MAX_EDGE = 1568;

/** The type the first bytes say, whatever the file name or clipboard claimed. */
export function sniffImageType(base64: string): ImageType | null {
	let head: string;
	try {
		head = atob(base64.slice(0, 24));
	} catch {
		return null;
	}
	const bytes = Array.from(head, (c) => c.charCodeAt(0));
	const starts = (...expected: number[]): boolean => expected.every((b, i) => bytes[i] === b);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
	if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
	return null;
}

/** Checked at the bridge: null when anything is wrong, so nothing half-valid is sent. */
export function validateImages(value: unknown): ChatImage[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > MAX_IMAGES) return null;
	const images: ChatImage[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) return null;
		const { data } = item as Record<string, unknown>;
		if (typeof data !== "string" || data.length === 0 || data.length > MAX_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
		const mediaType = sniffImageType(data);
		if (!mediaType) return null;
		images.push({ mediaType, data });
	}
	return images;
}

/** "data:image/png;base64,AAAA" → { mediaType: "image/png", data: "AAAA" }. */
export function splitDataUrl(url: string): { mediaType: string; data: string } {
	const match = /^data:([^;,]+);base64,/.exec(url);
	return match ? { mediaType: match[1] ?? "", data: url.slice(match[0].length) } : { mediaType: "", data: "" };
}
