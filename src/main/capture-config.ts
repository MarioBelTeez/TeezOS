import { VIEW_IDS, type ViewId } from "../shared/views.ts";

/**
 * Dev-only window capture, read from the environment: where the PNGs go, at
 * which widths, whether to quit afterwards and which view to show first.
 * Pure, so it is tested without Electron.
 *
 *   TEEZAI_CAPTURE=<folder>         turns capture mode on
 *   TEEZAI_CAPTURE_WIDTHS=1440,2560 content widths (height is 16:9)
 *   TEEZAI_CAPTURE_QUIT=1           quit once the PNGs are written
 *   TEEZAI_CAPTURE_VIEW=brain       a ViewId, "settings", "settings:<page>", "brain:graph" or "chat" to show first
 */

export const DEFAULT_CAPTURE_WIDTHS: readonly number[] = [1440, 2560];

/** Narrower than the window's minimum or wider than 8K is a typo, not a request. */
const MIN_WIDTH = 940;
const MAX_WIDTH = 7680;

export type CaptureView = ViewId | "settings" | `settings:${string}` | "brain:graph" | "chat";

export type CaptureConfig = {
	readonly folder: string;
	readonly widths: readonly number[];
	readonly quit: boolean;
	readonly view: CaptureView | null;
};

/** "1440, 2560" → [1440, 2560]; bad entries are dropped, duplicates once; nothing valid → the defaults. */
export function parseCaptureWidths(raw: string | undefined): readonly number[] {
	if (!raw) return DEFAULT_CAPTURE_WIDTHS;
	const widths: number[] = [];
	for (const part of raw.split(",")) {
		const text = part.trim();
		if (!/^\d+$/.test(text)) continue;
		const width = Number(text);
		if (width < MIN_WIDTH || width > MAX_WIDTH || widths.includes(width)) continue;
		widths.push(width);
	}
	return widths.length > 0 ? widths : DEFAULT_CAPTURE_WIDTHS;
}

/** The capture is 16:9: 1440 → 810, 2560 → 1440. */
export function captureHeight(width: number): number {
	return Math.round((width * 9) / 16);
}

export function parseCaptureView(raw: string | undefined): CaptureView | null {
	const text = raw?.trim().toLowerCase();
	if (!text) return null;
	if (text === "settings") return "settings";
	// The window checks the page name against its own list; here it only has to be a plain word.
	if (/^settings:[a-z]{1,20}$/.test(text)) return text as `settings:${string}`;
	if (text === "brain:graph" || text === "chat") return text;
	return (VIEW_IDS as readonly string[]).includes(text) ? (text as ViewId) : null;
}

/** Capture mode is for dev builds only; a packaged app ignores the variables entirely. */
export function captureConfig(env: Readonly<Record<string, string | undefined>>, isPackaged: boolean): CaptureConfig | null {
	if (isPackaged) return null;
	const folder = env["TEEZAI_CAPTURE"]?.trim();
	if (!folder) return null;
	return {
		folder,
		widths: parseCaptureWidths(env["TEEZAI_CAPTURE_WIDTHS"]),
		quit: env["TEEZAI_CAPTURE_QUIT"] === "1",
		view: parseCaptureView(env["TEEZAI_CAPTURE_VIEW"]),
	};
}
