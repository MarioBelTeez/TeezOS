import { activeWorkspaceIdOf, useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { useEditor } from "../state/editor.ts";
import { useChats } from "../state/chats.ts";
import { useTree } from "../state/tree.ts";
import { PANEL_KINDS } from "../../shared/desks.ts";
import { VIEW_META } from "./views.ts";
import { VIEW_IDS, enabledViews, panelEnabled } from "../../shared/views.ts";
import { isModuleEnabled } from "../../shared/modules.ts";
import { closeDesk, closePanel, cycleDesk, newDesk, openWorkspace, PANEL_LABEL, resetLayout, revealPanel, showView, toggleLock, togglePanel } from "./dock-actions.ts";

/**
 * Everything the command palette can do. Keyboard shortcuts call the same
 * functions, so a command behaves identically however it is reached.
 */

export type Command = {
	readonly id: string;
	readonly label: string;
	readonly keys?: string;
	readonly run: () => void;
};

function activeWorkspaceId(): string | null {
	return activeWorkspaceIdOf(useSettings.getState().settings);
}

export function activeTab(): { workspaceId: string; path: string } | null {
	const workspaceId = activeWorkspaceId();
	if (!workspaceId) return null;
	const path = useEditor.getState().byWorkspace[workspaceId]?.active;
	return path ? { workspaceId, path } : null;
}



export async function saveActive(): Promise<void> {
	const tab = activeTab();
	if (!tab) return;
	const ok = await useEditor.getState().save(tab.workspaceId, tab.path);
	if (!ok) useUi.getState().toast(`Could not save ${tab.path}`, "error");
}

/** Markdown preview for the active tab; false when the tab is not Markdown. */
export function togglePreviewActive(): boolean {
	const tab = activeTab();
	if (!tab || !/\.(md|markdown|mdx)$/i.test(tab.path)) return false;
	useEditor.getState().toggleRendered(tab.workspaceId, tab.path);
	return true;
}

export function closeActiveTab(): void {
	const tab = activeTab();
	if (tab) useEditor.getState().close(tab.workspaceId, tab.path);
}

export function buildCommands(): Command[] {
	const settings = useSettings.getState().settings;
	const workspaceId = activeWorkspaceId();
	const order = settings?.layout.viewOrder ?? [...VIEW_IDS];
	const enabled = enabledViews(order, (m) => settings ? isModuleEnabled(settings.modules, m) : true);

	const commands: Command[] = [
		...enabled.map((v) => {
			const meta = VIEW_META[v];
			return { id: `view.${v}`, label: `Show ${meta.label.split(" — ")[0] ?? meta.label}`, keys: meta.key, run: () => showView(v) };
		}),
		{ id: "view.settings", label: "Open Settings", keys: "Ctrl+,", run: () => useUi.getState().setView("settings") },
		{ id: "layout.terminal", label: "Toggle terminal", keys: "Ctrl+`", run: () => togglePanel("terminal") },
		{ id: "layout.chat", label: "Toggle chat", keys: "Ctrl+J", run: () => togglePanel("chat") },
		{ id: "layout.explorer", label: "Toggle explorer", keys: "Ctrl+B", run: () => togglePanel("explorer") },
		{ id: "layout.reset", label: "Reset this desk's layout", run: resetLayout },
		{ id: "layout.lock", label: "Lock / unlock the layout", run: toggleLock },
		...PANEL_KINDS.filter((panel) => !settings || panelEnabled(panel, settings.modules)).flatMap((panel) => [
			{ id: `panel.show.${panel}`, label: `Panel: show ${PANEL_LABEL[panel]}`, run: () => revealPanel(panel) },
			{ id: `panel.close.${panel}`, label: `Panel: close ${PANEL_LABEL[panel]}`, run: () => closePanel(panel) },
		]),
		{ id: "desk.new", label: "New desk", keys: "Ctrl+T", run: () => newDesk() },
		{ id: "desk.next", label: "Next desk", keys: "Ctrl+Tab", run: () => cycleDesk(1) },
		{ id: "desk.previous", label: "Previous desk", keys: "Ctrl+Shift+Tab", run: () => cycleDesk(-1) },
		{
			id: "desk.close",
			label: "Close this desk",
			run: () => {
				const layout = useSettings.getState().settings?.layout;
				if (layout) closeDesk(layout.activeDeskId);
			},
		},
		...(settings?.workspaces ?? []).map((w) => ({ id: `desk.new.${w.id}`, label: `New desk: ${w.name}`, run: () => newDesk(w.id) })),
		{ id: "file.open", label: "Open file…", keys: "Ctrl+P", run: () => useUi.getState().openPalette("files") },
		{ id: "file.save", label: "Save", keys: "Ctrl+S", run: () => void saveActive() },
		{ id: "file.close", label: "Close tab", keys: "Ctrl+W", run: closeActiveTab },
		{ id: "file.preview", label: "Markdown: toggle preview", keys: "Ctrl+Shift+V", run: () => void togglePreviewActive() },
		{
			id: "workspace.pin",
			label: "Pin a folder…",
			run: () => void window.teez.workspaces.pin().then((pinned) => pinned && openWorkspace(pinned.id)),
		},
	];

	if (workspaceId) {
		commands.push(
			{
				id: "chat.new.claude",
				label: "New chat with Claude",
				run: () => void useChats.getState().openChat(workspaceId, { agent: "claude" }),
			},
			{
				id: "chat.new.agy",
				label: "New chat with Antigravity",
				run: () => void useChats.getState().openChat(workspaceId, { agent: "agy" }),
			},
			{
				id: "explorer.collapse",
				label: "Collapse all folders",
				run: () => useTree.getState().collapseAll(workspaceId),
			},
			{
				id: "explorer.sessions",
				label: "Show past sessions",
				run: () => revealPanel("sessions"),
			},
			{
				id: "explorer.search",
				label: "Search in files",
				keys: "Ctrl+Shift+F",
				run: () => revealPanel("search"),
			},
			{
				id: "workspace.reveal",
				label: "Open workspace in File Explorer",
				run: () => void window.teez.workspaces.reveal(workspaceId, ""),
			},
		);
		const tab = activeTab();
		if (tab) {
			commands.push(
				{
					id: "file.reveal",
					label: "Reveal active file in tree",
					run: () => void useTree.getState().expandTo(tab.workspaceId, tab.path),
				},
				{
					id: "file.diff",
					label: "Toggle changes against last commit",
					run: () => useEditor.getState().toggleDiff(tab.workspaceId, tab.path),
				},
				{
					id: "file.ask",
					label: "Ask the agent about the active file",
					run: () => useUi.getState().insertIntoComposer(`@${tab.path} `),
				},
			);
		}
	}

	for (const workspace of settings?.workspaces ?? []) {
		commands.push({
			id: `workspace.open.${workspace.id}`,
			label: `Open project: ${workspace.name}`,
			run: () => openWorkspace(workspace.id),
		});
	}
	return commands;
}
