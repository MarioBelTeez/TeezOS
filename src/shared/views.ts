import type { ModuleId, Modules } from "./modules.ts";
import type { PanelKind } from "./desks.ts";

export const VIEW_IDS = ["code", "brain", "feed", "agents", "browser", "server", "automations"] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export const VIEW_MODULE: Readonly<Record<ViewId, ModuleId>> = {
	code: "editor",
	brain: "brain",
	feed: "feed",
	agents: "agents",
	browser: "browser",
	server: "server",
	automations: "automations",
};

export function enabledViews(order: readonly ViewId[], enabled: (m: ModuleId) => boolean): ViewId[] {
	return order.filter((v) => v === "code" || enabled(VIEW_MODULE[v]));
}

/** The hidden views once `module` is turned on: its own view comes back to the bar. */
export function unhideModuleViews(hidden: readonly ViewId[], module: ModuleId): ViewId[] {
	return hidden.filter((v) => VIEW_MODULE[v] !== module);
}

/** The module each panel belongs to: a disabled module's panels are never on a desk. The code panels are the editor's, which is always on. */
export const PANEL_MODULE: Readonly<Record<PanelKind, ModuleId>> = {
	editor: "editor",
	explorer: "editor",
	search: "editor",
	git: "editor",
	sessions: "editor",
	chat: "chat",
	terminal: "terminal",
	brain: "brain",
	feed: "feed",
	agents: "agents",
	browser: "browser",
	server: "server",
	automations: "automations",
};

export function panelEnabled(panel: PanelKind, modules: Modules): boolean {
	return modules[PANEL_MODULE[panel]].enabled;
}
