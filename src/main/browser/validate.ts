/**
 * Checks for what the renderer sends the browser. The renderer is untrusted
 * too: ids have one shape, text has a length, a rect is four sane numbers.
 */

export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

const TAB_ID = /^[a-z0-9-]{1,40}$/;
export const MAX_TEXT = 2048;
/** Bigger than any screen; a rect past this is nonsense. */
const MAX_COORD = 100_000;

export const isTabId = (value: unknown): value is string => typeof value === "string" && TAB_ID.test(value);
export const isBrowserText = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_TEXT;
const isCoord = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COORD;

/** A rect, null (hide the tab), or undefined for anything else. */
export function parseRect(value: unknown): Rect | null | undefined {
	if (value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const { x, y, width, height } = value as Record<string, unknown>;
	if (!isCoord(x) || !isCoord(y) || !isCoord(width) || !isCoord(height)) return undefined;
	return { x, y, width, height };
}
