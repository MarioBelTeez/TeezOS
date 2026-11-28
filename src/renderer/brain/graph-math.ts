import type { LabelMode } from "../../shared/modules.ts";

export function nodeRadius(links: number): number {
	return 3 + Math.sqrt(Math.max(0, links)) * 1.6;
}

export const FOLDER_COLORS: Readonly<Record<string, string>> = {
	brain: "#ff1744",
	work: "#e8002d",
	reference: "#ff8a3d",
	org: "#7c6cff",
	perf: "#ffd166",
	thinking: "#6b5b62",
	other: "#b8a9b0",
};

export function folderColor(path: string): string {
	const slash = path.indexOf("/");
	const segment = slash === -1 ? path : path.slice(0, slash);
	const color = FOLDER_COLORS[segment];
	if (color !== undefined && segment !== "other") {
		return color;
	}
	return FOLDER_COLORS["other"] ?? "#b8a9b0";
}

/** The theme's accent pair, as the canvas needs literal colours rather than CSS variables. */
export type GraphAccent = { readonly red: string; readonly hot: string; readonly redRgb: string; readonly text: string };

export const DEFAULT_GRAPH_ACCENT: GraphAccent = { red: "#e8002d", hot: "#ff1744", redRgb: "232 0 45", text: "#f5f0f2" };

/**
 * A node's colour under the current theme: the two accent folders (brain, work)
 * follow the theme; the other folders are categories and keep their own hues.
 */
export function themedNodeColor(color: string, accent: GraphAccent): string {
	if (color === FOLDER_COLORS["brain"]) return accent.hot;
	if (color === FOLDER_COLORS["work"]) return accent.red;
	return color;
}

/** "232 0 45" + 0.7 → "rgba(232,0,45,0.7)". */
export function rgba(rgbTriplet: string, alpha: number): string {
	return `rgba(${rgbTriplet.trim().split(/\s+/).join(",")},${alpha})`;
}

export function labelAlpha(k: number, mode: LabelMode): number {
	if (mode === "never") return 0;
	if (mode === "always") return 1;
	if (k <= 0.8) return 0;
	if (k >= 1.2) return 1;
	return (k - 0.8) / 0.4;
}

/** Zoom past which the compact local graph labels every note. */
const COMPACT_LABEL_ZOOM = 1.8;

/**
 * How visible one note's label is: the current note, the hovered one and its
 * neighbours always; in the compact local graph the rest only zoomed in past
 * 1.8 (it is small, labels would pile up); in the full graph per the label
 * setting. Faded along with the node itself.
 */
export function graphLabelAlpha(note: {
	readonly hovered: boolean;
	readonly neighbour: boolean;
	readonly current: boolean;
	readonly compact: boolean;
	readonly k: number;
	readonly mode: LabelMode;
	readonly nodeAlpha: number;
}): number {
	if (note.current || note.hovered || note.neighbour) return 1;
	const base = note.compact ? (note.mode !== "never" && note.k > COMPACT_LABEL_ZOOM ? 1 : 0) : labelAlpha(note.k, note.mode);
	return base * note.nodeAlpha;
}

export function approach(current: number, target: number, rate: number, dt: number): number {
	return target + (current - target) * Math.exp(-rate * dt);
}

export function inertiaStep(v: { readonly x: number; readonly y: number }, dtMs: number): { x: number; y: number } {
	const factor = Math.pow(0.9, dtMs / 16.67);
	const x = v.x * factor;
	const y = v.y * factor;
	if (Math.hypot(x, y) < 0.01) {
		return { x: 0, y: 0 };
	}
	return { x, y };
}

export function zoomAround(
	view: { readonly x: number; readonly y: number; readonly k: number },
	cursor: { readonly x: number; readonly y: number },
	nextK: number,
): { x: number; y: number; k: number } {
	const k = Math.min(6, Math.max(0.15, nextK));
	const x = cursor.x - ((cursor.x - view.x) * k) / view.k;
	const y = cursor.y - ((cursor.y - view.y) * k) / view.k;
	return { x, y, k };
}
