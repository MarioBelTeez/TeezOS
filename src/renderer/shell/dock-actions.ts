import { create } from "zustand";
import type { DockviewApi, SerializedDockview } from "dockview-react";
import type { LayoutSettings } from "../../main/settings/store.ts";
import type { ViewId } from "../../shared/dock.ts";
import {
	MAX_DESKS,
	closeDesk as closeDeskIn,
	firstLayout,
	insertDesk,
	isPanelKind,
	placementFor,
	renameDesk as renameDeskIn,
	reorderDesks,
	type Desk,
	type PanelKind,
	type PlanStep,
} from "../../shared/desks.ts";
import { startupDesk } from "../../shared/startup.ts";
import { panelEnabled } from "../../shared/views.ts";
import { MODULE_IDS } from "../../shared/modules.ts";
import { presetFromState, presetModulesPatch, type Preset } from "../../shared/presets.ts";
import { agentPatchOf, presetChatOf } from "./preset-chat.ts";
import { shouldSaveGrid } from "./grid-save.ts";
import { activeWorkspaceIdOf, useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { appTrail, recordDeskSwitch, viewEntry } from "../state/app-trail.ts";

/**
 * Everything that changes the desk: which desk is in front, which panels are
 * on it and where. Shortcuts, buttons and menus all come through here, and
 * they follow the panel, not the place: Ctrl+` is the terminal wherever it
 * was dragged. The open desk is one dockview grid; switching desks saves
 * this one's grid and loads the other's.
 */

export const PANEL_LABEL: Readonly<Record<PanelKind, string>> = {
	editor: "Editor",
	explorer: "Explorer",
	search: "Search",
	git: "Source control",
	sessions: "Past sessions",
	chat: "Chat",
	terminal: "Terminal",
	brain: "Brain",
	feed: "Feed the Brain",
	agents: "Agents",
	browser: "Browser",
	server: "Server",
	automations: "Automations",
};

export const VIEW_PANEL: Readonly<Record<ViewId, PanelKind>> = { code: "editor", brain: "brain", feed: "feed", agents: "agents", browser: "browser", server: "server", automations: "automations" };

/** What is on the open desk, for anything that draws state (the left bar, the status bar, menus). */
type DeskState = {
	readonly open: readonly PanelKind[];
	/** Panels showing: the picked tab of each group. */
	readonly visible: readonly PanelKind[];
};

export const useDesk = create<DeskState>(() => ({ open: [], visible: [] }));

/** Told whenever the grid moves or resizes anything, for what must follow a panel's place on screen (the browser's page). */
const layoutListeners = new Set<() => void>();
export function onDeskLayout(listener: () => void): () => void {
	layoutListeners.add(listener);
	return () => layoutListeners.delete(listener);
}
function layoutChanged(): void {
	for (const listener of layoutListeners) listener();
}

let api: DockviewApi | null = null;
/** The current attachment: set false the moment its Desk lets go, so nothing saves from a dockview on its way out. */
let attached: { readonly api: DockviewApi; live: boolean } | null = null;
let loadedDeskId: string | null = null;
let loading = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let startupApplied = false;

const SAVE_DELAY_MS = 300;

function layout(): LayoutSettings | null {
	return useSettings.getState().settings?.layout ?? null;
}

/** Whether a panel may be on a desk: a disabled module's panels never are. Before settings load, everything is. */
function allowed(panel: PanelKind): boolean {
	const modules = useSettings.getState().settings?.modules;
	return !modules || panelEnabled(panel, modules);
}

/** Panels that are not ours (an older version's) or whose module is off leave the grid. */
function dropUnwanted(): void {
	if (!api) return;
	for (const panel of [...api.panels]) if (!isPanelKind(panel.id) || !allowed(panel.id)) panel.api.close();
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function refreshState(): void {
	if (!api) return;
	const open = api.panels.map((p) => p.id).filter(isPanelKind);
	const visible = api.groups.map((g) => g.activePanel?.id).filter(isPanelKind);
	const current = useDesk.getState();
	if (!same(open, current.open) || !same(visible, current.visible)) useDesk.setState({ open, visible });
}

/** The desks with the open one's grid as it is right now. */
function desksWithCurrentGrid(desks: readonly Desk[]): Desk[] {
	if (!api || !loadedDeskId) return [...desks];
	const grid = api.toJSON();
	return desks.map((d) => (d.id === loadedDeskId ? { ...d, grid } : d));
}

function cancelSave(): void {
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = null;
}

/** Writes the open desk's grid back, unless the dockview showing it has been let go of (see grid-save.ts). */
function saveNow(detaching = false): void {
	cancelSave();
	const current = layout();
	if (!current || !api || !loadedDeskId || attached?.api !== api) return;
	const previous = current.desks.find((d) => d.id === loadedDeskId)?.grid ?? null;
	const grid = api.toJSON();
	if (!shouldSaveGrid({ disposed: !attached.live, detaching, grid, previous })) return;
	const openId = loadedDeskId;
	useSettings.getState().setLayout({ desks: current.desks.map((d) => (d.id === openId ? { ...d, grid } : d)) });
}

function scheduleSave(): void {
	if (loading) return;
	cancelSave();
	saveTimer = setTimeout(() => saveNow(), SAVE_DELAY_MS);
}

function addPanel(step: PlanStep): void {
	if (!api || api.getPanel(step.panel)) return;
	const { placement } = step;
	const position = !placement
		? undefined
		: "reference" in placement
			? api.getPanel(placement.reference)
				? { referencePanel: placement.reference, direction: placement.direction }
				: undefined
			: { direction: placement.direction };
	api.addPanel({
		id: step.panel,
		component: step.panel,
		title: PANEL_LABEL[step.panel],
		...(position ? { position } : {}),
		...(step.inactive ? { inactive: true } : {}),
		...(step.width ? { initialWidth: step.width } : {}),
		...(step.height ? { initialHeight: step.height } : {}),
	});
}

/** Lays out an empty grid step by step: a new desk's first layout and a plan preset both come through here. */
function layOut(steps: readonly PlanStep[]): void {
	for (const step of steps) if (allowed(step.panel)) addPanel(step);
}

function buildFirst(from: LayoutSettings | null): void {
	const steps = from
		? firstLayout(
				from.dock,
				{ left: from.leftOpen, right: from.rightOpen, bottom: from.bottomOpen },
				{ left: from.leftWidth, right: from.rightWidth, bottom: from.bottomHeight },
			)
		: firstLayout();
	layOut(steps);
}

function loadDesk(desk: Desk): void {
	if (!api) return;
	cancelSave();
	loading = true;
	try {
		api.clear();
		if (desk.grid) {
			try {
				api.fromJSON(desk.grid as SerializedDockview);
			} catch {
				// A grid this version cannot read (or a panel that no longer exists): start over.
				api.clear();
				buildFirst(layout());
			}
		} else {
			buildFirst(layout());
		}
		dropUnwanted();
	} finally {
		loading = false;
	}
	loadedDeskId = desk.id;
	refreshState();
}

/** Tell the main process which project is in front (the window already knows, from the desk). */
function activateWorkspace(workspaceId: string): void {
	if (workspaceId && useSettings.getState().settings?.activeWorkspaceId !== workspaceId) void window.teez.workspaces.activate(workspaceId);
}

/** The desk component hands over its grid once it is ready; the returned function lets go. */
export function attachDesk(next: DockviewApi): () => void {
	api = next;
	const attachment = { api: next, live: true };
	attached = attachment;
	const subscriptions = [
		next.onDidLayoutChange(() => {
			refreshState();
			scheduleSave();
			layoutChanged();
		}),
		next.onDidMaximizedGroupChange(layoutChanged),
		next.onDidActivePanelChange(refreshState),
		next.onDidAddPanel(refreshState),
		next.onDidRemovePanel(refreshState),
	];
	const current = layout();
	const desk = current?.desks.find((d) => d.id === current.activeDeskId);
	if (desk) {
		loadDesk(desk);
		activateWorkspace(desk.workspaceId);
	}
	const startupSettings = useSettings.getState().settings;
	if (!startupApplied && startupSettings) {
		startupApplied = true;
		const action = startupDesk({
			desks: startupSettings.layout.desks,
			activeDeskId: startupSettings.layout.activeDeskId,
			workspaces: startupSettings.workspaces,
			vaultPath: startupSettings.vaultPath,
		});
		if (action.kind === "switch") switchDesk(action.deskId);
		else if (action.kind === "create") newDesk(action.workspaceId);
	}
	// The active desk can change from outside (its project unpinned): follow it.
	// A module turned off takes its panels off the desk; other desks drop them when they open.
	const offSettings = useSettings.subscribe((state, previous) => {
		if (state.settings?.modules !== previous.settings?.modules) dropUnwanted();
		const now = state.settings?.layout;
		if (!now || now.activeDeskId === loadedDeskId) return;
		const target = now.desks.find((d) => d.id === now.activeDeskId);
		if (target) loadDesk(target);
	});
	return () => {
		offSettings();
		for (const subscription of subscriptions) subscription.dispose();
		if (api !== next || attached !== attachment) {
			attachment.live = false;
			return;
		}
		// The last save of this attachment, then it is let go of: a timer still pending saves nothing.
		saveNow(true);
		attachment.live = false;
		attached = null;
		api = null;
		loadedDeskId = null;
	};
}

export function switchDesk(id: string, options: { readonly record?: boolean } = {}): void {
	const current = layout();
	const target = current?.desks.find((d) => d.id === id);
	if (!current || !target) return;
	if (useUi.getState().view === "settings") useUi.getState().setView("desk");
	if (id === loadedDeskId) return;
	// The desk being left is the trail's start if nothing was recorded yet, so Back can return to it.
	if (options.record !== false) recordDeskSwitch(current.activeDeskId, id);
	const desks = desksWithCurrentGrid(current.desks);
	cancelSave();
	loadedDeskId = id;
	useSettings.getState().setLayout({ desks, activeDeskId: id });
	activateWorkspace(target.workspaceId);
	loadDesk(target);
}

export function cycleDesk(step: 1 | -1): void {
	const current = layout();
	if (!current || current.desks.length < 2) return;
	const index = current.desks.findIndex((d) => d.id === current.activeDeskId);
	const next = current.desks[(index + step + current.desks.length) % current.desks.length];
	if (next) switchDesk(next.id);
}

/** A new desk for a project, laid out like the one in front. */
export function newDesk(workspaceId?: string): void {
	const current = layout();
	if (!current) return;
	if (current.desks.length >= MAX_DESKS) {
		useUi.getState().toast(`${MAX_DESKS} desks is the most; close one first.`, "error");
		return;
	}
	const project = workspaceId ?? activeWorkspaceIdOf(useSettings.getState().settings) ?? "";
	const desk: Desk = { id: `desk-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: "", workspaceId: project, grid: api ? api.toJSON() : null };
	const desks = insertDesk(desksWithCurrentGrid(current.desks), desk, current.activeDeskId);
	cancelSave();
	loadedDeskId = desk.id;
	useSettings.getState().setLayout({ desks, activeDeskId: desk.id });
	if (useUi.getState().view === "settings") useUi.getState().setView("desk");
	activateWorkspace(project);
	loadDesk(desk);
}

/** The project's desk if it has one, else a new one: the left bar's tiles work like bookmarks. */
export function openWorkspace(workspaceId: string): void {
	const current = layout();
	if (!current) return;
	const active = current.desks.find((d) => d.id === current.activeDeskId);
	if (active?.workspaceId === workspaceId) return switchDesk(active.id);
	const existing = current.desks.find((d) => d.workspaceId === workspaceId);
	if (existing) switchDesk(existing.id);
	else newDesk(workspaceId);
}

export function closeDesk(id: string): void {
	const current = layout();
	if (!current) return;
	const result = closeDeskIn(desksWithCurrentGrid(current.desks), id, current.activeDeskId);
	if (result.desks.length === current.desks.length) return;
	const target = result.desks.find((d) => d.id === result.activeDeskId);
	const switching = !!target && id === loadedDeskId;
	cancelSave();
	if (switching && target) loadedDeskId = target.id;
	useSettings.getState().setLayout(result);
	if (switching && target) {
		activateWorkspace(target.workspaceId);
		loadDesk(target);
	}
}

/**
 * Before a project is unpinned: its desks close, so nothing points at it. When
 * every desk is that project's, the last one keeps its layout and moves to
 * another pinned project instead.
 */
export function closeDesksOf(workspaceId: string): void {
	for (const desk of layout()?.desks ?? []) if (desk.workspaceId === workspaceId) closeDesk(desk.id);
	const settings = useSettings.getState().settings;
	const left = settings?.layout.desks ?? [];
	const other = settings?.workspaces.find((w) => w.id !== workspaceId);
	if (!settings || !other || left.some((d) => d.workspaceId !== workspaceId)) return;
	useSettings.getState().setLayout({ desks: left.map((d) => ({ ...d, workspaceId: other.id, name: "" })) });
	activateWorkspace(other.id);
}

export function renameDesk(id: string, name: string): void {
	const current = layout();
	if (current) useSettings.getState().setLayout({ desks: renameDeskIn(desksWithCurrentGrid(current.desks), id, name) });
}

export function moveDesk(moved: string, target: string, after: boolean): void {
	const current = layout();
	if (current) useSettings.getState().setLayout({ desks: reorderDesks(desksWithCurrentGrid(current.desks), moved, target, after) });
}

export function isPanelShown(panel: PanelKind): boolean {
	return useDesk.getState().visible.includes(panel);
}

/** Bring a panel into view: its tab picked if it is on the desk, else opened where it belongs. */
export function revealPanel(panel: PanelKind): void {
	// A disabled module's panel (Ctrl+5 for a Browser that is off, say) is not shown.
	if (!allowed(panel)) return;
	if (useUi.getState().view === "settings") useUi.getState().setView("desk");
	if (!api) return;
	const existing = api.getPanel(panel);
	if (existing) {
		existing.api.setActive();
		return;
	}
	const current = layout();
	const has = (p: PanelKind): boolean => !!api?.getPanel(p);
	const placement = placementFor(panel, has);
	const edge = placement && !("reference" in placement) ? placement.direction : null;
	addPanel({
		panel,
		placement,
		inactive: false,
		...(edge === "left" ? { width: current?.leftWidth ?? 260 } : {}),
		...(edge === "right" ? { width: current?.rightWidth ?? 460 } : {}),
		...(edge === "below" ? { height: current?.bottomHeight ?? 240 } : {}),
	});
}

export function closePanel(panel: PanelKind): void {
	api?.getPanel(panel)?.api.close();
}

export function togglePanel(panel: PanelKind): void {
	if (useUi.getState().view !== "settings" && isPanelShown(panel)) closePanel(panel);
	else revealPanel(panel);
}

export function showView(view: ViewId, options: { readonly record?: boolean } = {}): void {
	if (options.record !== false) appTrail.push(viewEntry(view));
	revealPanel(VIEW_PANEL[view]);
}

/** The open desk back to the first layout. */
export function resetLayout(): void {
	if (!api) return;
	loading = true;
	try {
		api.clear();
		buildFirst(null);
	} finally {
		loading = false;
	}
	refreshState();
	saveNow();
}

/**
 * A preset onto the open desk (only this one): its panels laid out like a new
 * desk's first layout, or its saved grid; then its modules and chat defaults.
 * Module flags go first, so the layout already knows which panels are allowed.
 */
export function applyPreset(preset: Preset): void {
	const settings = useSettings.getState();
	const modules = presetModulesPatch(preset.modules);
	if (Object.keys(modules).length > 0) settings.setModules(modules);
	if (preset.chat) settings.setAgent(agentPatchOf(preset.chat));
	if (useUi.getState().view === "settings") useUi.getState().setView("desk");
	if (!api) return;
	cancelSave();
	loading = true;
	try {
		api.clear();
		if (preset.layout.kind === "plan") {
			layOut(preset.layout.steps);
		} else {
			try {
				api.fromJSON(preset.layout.grid as SerializedDockview);
			} catch {
				// A grid this version cannot read: the first layout, rather than an empty desk.
				api.clear();
			}
		}
		dropUnwanted();
		// Nothing left (every panel of it turned off): the first layout, never a blank desk.
		if (api.panels.length === 0) buildFirst(layout());
	} finally {
		loading = false;
	}
	refreshState();
	saveNow();
}

const randomId = (): string => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

/** The open desk, the modules that are on and the chat defaults, as a new user preset. */
export function presetFromCurrent(name: string): Preset {
	const settings = useSettings.getState().settings;
	const desk = settings?.layout.desks.find((d) => d.id === settings.layout.activeDeskId);
	const enabled: Partial<Record<(typeof MODULE_IDS)[number], boolean>> = {};
	if (settings) for (const id of MODULE_IDS) enabled[id] = settings.modules[id].enabled;
	return presetFromState({
		id: `p-${randomId()}`,
		name,
		grid: api ? api.toJSON() : (desk?.grid ?? null),
		enabled,
		chat: settings ? presetChatOf(settings.agent) : null,
	});
}

export function toggleLock(): void {
	const current = layout();
	if (current) useSettings.getState().setLayout({ locked: !current.locked });
}
