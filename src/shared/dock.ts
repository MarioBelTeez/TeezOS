/**
 * The 0.2.3 dock: three areas (left, right, bottom), each an ordered list of
 * panels. Desks (desks.ts) replaced it; a saved dock still seeds a desk's
 * first layout, so an upgrade keeps panels where they were. Also the left
 * bar's views, their order and which are hidden.
 */

import { VIEW_IDS, type ViewId } from "./views.ts";

export type PanelId = "explorer" | "search" | "git" | "sessions" | "chat" | "terminal";
export type DockArea = "left" | "right" | "bottom";
export type Dock = Readonly<Record<DockArea, readonly PanelId[]>>;
/** The views in the left bar (Settings stays at the foot, always). */
export type { ViewId };

export const PANELS: readonly PanelId[] = ["explorer", "search", "git", "sessions", "chat", "terminal"];
export const AREAS: readonly DockArea[] = ["left", "right", "bottom"];
export const DEFAULT_DOCK: Dock = { left: ["explorer", "search", "git", "sessions"], right: ["chat"], bottom: ["terminal"] };
export const DEFAULT_VIEW_ORDER: readonly ViewId[] = VIEW_IDS;

const isPanel = (value: unknown): value is PanelId => typeof value === "string" && (PANELS as readonly string[]).includes(value);
const isView = (value: unknown): value is ViewId => typeof value === "string" && (VIEW_IDS as readonly string[]).includes(value);

export function areaOf(dock: Dock, panel: PanelId): DockArea {
	return AREAS.find((area) => dock[area].includes(panel)) ?? "left";
}

/** Whatever was saved, made whole: each known panel once; one that went missing returns to its default area. */
export function normalizeDock(value: unknown): Dock {
	const saved = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	const seen = new Set<PanelId>();
	const dock: Record<DockArea, PanelId[]> = { left: [], right: [], bottom: [] };
	for (const area of AREAS) {
		const list = saved[area];
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (!isPanel(item) || seen.has(item)) continue;
			seen.add(item);
			dock[area].push(item);
		}
	}
	if (seen.size === 0) return DEFAULT_DOCK;
	for (const panel of PANELS) {
		if (!seen.has(panel)) dock[areaOf(DEFAULT_DOCK, panel)].push(panel);
	}
	return dock;
}

/** The left bar's views: a full order (unknown dropped, missing appended); Code can never be hidden. */
export function normalizeViews(order: unknown, hidden: unknown): { order: ViewId[]; hidden: ViewId[] } {
	const ordered: ViewId[] = [];
	for (const item of Array.isArray(order) ? order : []) if (isView(item) && !ordered.includes(item)) ordered.push(item);
	for (const view of VIEW_IDS) if (!ordered.includes(view)) ordered.push(view);
	const gone: ViewId[] = [];
	for (const item of Array.isArray(hidden) ? hidden : []) if (isView(item) && item !== "code" && !gone.includes(item)) gone.push(item);
	return { order: ordered, hidden: gone };
}
