import { DEFAULT_DOCK, type Dock, type DockArea } from "./dock.ts";

/**
 * Desks are the tabs along the top: each one is a project (a pinned
 * workspace) with its own arrangement of panels. Every panel can sit anywhere
 * on a desk; the grid itself is dockview's JSON, kept opaque here. Pure, so
 * the main process cleans what is saved and the window opens, closes and
 * reorders desks by the same rules.
 */

export type PanelKind = "editor" | "explorer" | "search" | "git" | "sessions" | "chat" | "terminal" | "brain" | "feed" | "agents" | "browser" | "server" | "automations";

export const PANEL_KINDS: readonly PanelKind[] = ["editor", "explorer", "search", "git", "sessions", "chat", "terminal", "brain", "feed", "agents", "browser", "server", "automations"];

export const isPanelKind = (value: unknown): value is PanelKind => typeof value === "string" && (PANEL_KINDS as readonly string[]).includes(value);

export type Desk = {
	readonly id: string;
	/** "" shows the workspace's name. */
	readonly name: string;
	/** "" only while nothing is pinned. */
	readonly workspaceId: string;
	/** dockview's serialized layout, or null to build the first one. */
	readonly grid: unknown;
};

export const MAX_DESKS = 12;
export const MAX_DESK_NAME = 40;
/** A grid larger than this is not a layout someone made; it is dropped and rebuilt. */
export const MAX_GRID_CHARS = 200_000;

const ID = /^[A-Za-z0-9_-]{1,40}$/;

const isBag = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function cleanGrid(value: unknown): unknown {
	if (!isBag(value)) return null;
	try {
		return JSON.stringify(value).length <= MAX_GRID_CHARS ? value : null;
	} catch {
		return null;
	}
}

/**
 * Whatever was saved, made whole: at most MAX_DESKS desks with unique ids, a
 * desk whose project was unpinned closed, a desk with no project given the
 * active one, and never zero desks.
 */
export function normalizeDesks(
	value: unknown,
	activeDeskId: unknown,
	workspaceIds: readonly string[],
	activeWorkspaceId: string | null,
): { desks: Desk[]; activeDeskId: string } {
	const desks: Desk[] = [];
	for (const item of Array.isArray(value) ? value : []) {
		if (desks.length >= MAX_DESKS) break;
		if (!isBag(item)) continue;
		const id = item["id"];
		if (typeof id !== "string" || !ID.test(id) || desks.some((d) => d.id === id)) continue;
		const saved = typeof item["workspaceId"] === "string" ? item["workspaceId"] : "";
		if (saved && !workspaceIds.includes(saved)) continue;
		const name = typeof item["name"] === "string" ? item["name"].trim().slice(0, MAX_DESK_NAME) : "";
		desks.push({ id, name, workspaceId: saved || (activeWorkspaceId ?? ""), grid: cleanGrid(item["grid"]) });
	}
	if (desks.length === 0) desks.push({ id: "desk-1", name: "", workspaceId: activeWorkspaceId ?? "", grid: null });
	const active = desks.find((d) => d.id === activeDeskId) ?? desks[0];
	return { desks, activeDeskId: active?.id ?? "desk-1" };
}

export function deskTitle(desk: Desk, workspaces: readonly { readonly id: string; readonly name: string }[]): string {
	return desk.name || workspaces.find((w) => w.id === desk.workspaceId)?.name || "Desk";
}

/** A desk closed; the one beside it takes over when it was the active one. The last desk stays. */
export function closeDesk(desks: readonly Desk[], id: string, activeDeskId: string): { desks: Desk[]; activeDeskId: string } {
	const index = desks.findIndex((d) => d.id === id);
	if (index < 0 || desks.length <= 1) return { desks: [...desks], activeDeskId };
	const rest = desks.filter((d) => d.id !== id);
	if (id !== activeDeskId) return { desks: rest, activeDeskId };
	return { desks: rest, activeDeskId: (rest[Math.min(index, rest.length - 1)] ?? rest[0])?.id ?? activeDeskId };
}

/** `desk` placed right after `afterId` (or at the end). */
export function insertDesk(desks: readonly Desk[], desk: Desk, afterId: string | null): Desk[] {
	const index = afterId ? desks.findIndex((d) => d.id === afterId) : -1;
	if (index < 0) return [...desks, desk];
	return [...desks.slice(0, index + 1), desk, ...desks.slice(index + 1)];
}

/** `moved` dropped on `target`: before it, or after it when dropped on its right half. */
export function reorderDesks(desks: readonly Desk[], moved: string, target: string, after: boolean): Desk[] {
	const item = desks.find((d) => d.id === moved);
	if (!item || moved === target) return [...desks];
	const rest = desks.filter((d) => d.id !== moved);
	const index = rest.findIndex((d) => d.id === target);
	if (index < 0) return [...desks];
	return [...rest.slice(0, after ? index + 1 : index), item, ...rest.slice(after ? index + 1 : index)];
}

export function renameDesk(desks: readonly Desk[], id: string, name: string): Desk[] {
	return desks.map((d) => (d.id === id ? { ...d, name: name.trim().slice(0, MAX_DESK_NAME) } : d));
}

/** Where a panel goes when it is opened: next to a panel it belongs with, else at an edge. */
export type Placement =
	| { readonly direction: "left" | "right" | "above" | "below" }
	| { readonly direction: "within" | "left" | "right" | "above" | "below"; readonly reference: PanelKind };

const SIDE: readonly PanelKind[] = ["explorer", "search", "git", "sessions"];
const CENTER: readonly PanelKind[] = ["editor", "brain", "feed", "agents", "browser", "server", "automations"];

export function placementFor(panel: PanelKind, has: (panel: PanelKind) => boolean): Placement | null {
	const beside = (group: readonly PanelKind[]): Placement | null => {
		const sibling = group.find((p) => p !== panel && has(p));
		return sibling ? { direction: "within", reference: sibling } : null;
	};
	if (SIDE.includes(panel)) return beside(SIDE) ?? { direction: "left" };
	if (CENTER.includes(panel)) return beside(CENTER);
	if (panel === "chat") return { direction: "right" };
	return { direction: "below" };
}

export type PlanStep = {
	readonly panel: PanelKind;
	readonly placement: Placement | null;
	/** Added behind the first tab of its group. */
	readonly inactive: boolean;
	readonly width?: number;
	readonly height?: number;
};

const EDGE: Readonly<Record<DockArea, "left" | "right" | "below">> = { left: "left", right: "right", bottom: "below" };

/**
 * The first layout of a desk, from the 0.2.3 dock: the editor in the middle,
 * each open area's panels as tabs on its edge. Left and right go in before
 * the bottom so the bottom spans the whole width, as it did.
 */
export function firstLayout(
	dock: Dock = DEFAULT_DOCK,
	open: Readonly<Record<DockArea, boolean>> = { left: true, right: true, bottom: false },
	size: { readonly left: number; readonly right: number; readonly bottom: number } = { left: 260, right: 460, bottom: 240 },
): PlanStep[] {
	const steps: PlanStep[] = [{ panel: "editor", placement: null, inactive: false }];
	for (const area of ["left", "right", "bottom"] as const) {
		const [first, ...rest] = dock[area];
		if (!open[area] || !first) continue;
		steps.push({
			panel: first,
			placement: { direction: EDGE[area] },
			inactive: false,
			...(area === "bottom" ? { height: size.bottom } : { width: area === "left" ? size.left : size.right }),
		});
		for (const panel of rest) steps.push({ panel, placement: { direction: "within", reference: first }, inactive: true });
	}
	return steps;
}
