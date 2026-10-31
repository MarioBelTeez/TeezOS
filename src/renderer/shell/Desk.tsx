import { useEffect, useRef, useState } from "react";
import {
	DockviewReact,
	themeDark,
	type DockviewTheme,
	type IDockviewHeaderActionsProps,
	type IDockviewPanelHeaderProps,
	type IDockviewPanelProps,
	type IWatermarkPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Brain, FileCode2, Files, GitBranch, Globe, History, Maximize2, MessageSquare, Minimize2, Network, PictureInPicture2, Search, Server, Sparkles, TerminalSquare, Timer, X } from "lucide-react";
import type { Workspace } from "../../main/settings/store.ts";
import { PANEL_KINDS, isPanelKind, type PanelKind } from "../../shared/desks.ts";
import { useActiveWorkspace, useSettings } from "../state/settings.ts";
import { Explorer } from "../explorer/Explorer.tsx";
import { SearchPanel } from "../panels/SearchPanel.tsx";
import { GitPanel } from "../panels/GitPanel.tsx";
import { SessionsPanel } from "../panels/SessionsPanel.tsx";
import { ChatPanel } from "../chat/ChatPanel.tsx";
import { TerminalDock } from "../terminal/TerminalDock.tsx";
import { EditorArea } from "../editor/EditorArea.tsx";
import { BrainView } from "../views/BrainView.tsx";
import { FeedView } from "../views/FeedView.tsx";
import { AgentsView } from "../views/AgentsView.tsx";
import { BrowserView } from "../views/BrowserView.tsx";
import { ServerView } from "../views/ServerView.tsx";
import { AutomationsView } from "../views/AutomationsView.tsx";
import { PANEL_LABEL, attachDesk, revealPanel } from "./dock-actions.ts";

/**
 * The desk: one grid where every panel can go anywhere. Drag a tab onto
 * another group to stack it there, onto a group's edge to split, or out of
 * the grid's edge; right-click a tab to float or maximize it. Where things
 * are is saved per desk (see dock-actions.ts).
 */

export const PANEL_ICON: Readonly<Record<PanelKind, typeof Files>> = {
	editor: FileCode2,
	explorer: Files,
	search: Search,
	git: GitBranch,
	sessions: History,
	chat: MessageSquare,
	terminal: TerminalSquare,
	brain: Brain,
	feed: Sparkles,
	agents: Network,
	browser: Globe,
	server: Server,
	automations: Timer,
};

const THEME: DockviewTheme = { ...themeDark, name: "teez", gap: 0 };
/** A floated group opens big enough to use; drag its top bar to move it, its edges to size it. */
const FLOAT_SIZE = { x: 120, y: 80, width: 640, height: 440 };

/** Panels about one project show the active desk's; without one there is nothing to show. */
function forWorkspace(Render: (props: { readonly workspace: Workspace }) => React.JSX.Element, className: string) {
	return function WorkspacePanel(): React.JSX.Element {
		const workspace = useActiveWorkspace();
		return (
			<div className={`h-full min-h-0 min-w-0 overflow-hidden ${className}`}>
				{workspace ? <Render workspace={workspace} /> : <NoProject />}
			</div>
		);
	};
}

function whole(Render: () => React.JSX.Element) {
	return function WholePanel(): React.JSX.Element {
		return (
			// The view fills the panel: a view root without flex-1 would otherwise shrink to its content and sit top-left.
			<div className="flex h-full min-h-0 min-w-0 overflow-hidden *:min-w-0 *:flex-1">
				<Render />
			</div>
		);
	};
}

/** Side panels are glass over the desk's red light. */
const SIDE = "glass";

const COMPONENTS: Readonly<Record<PanelKind, React.FunctionComponent<IDockviewPanelProps>>> = {
	editor: forWorkspace(EditorArea, "flex"),
	explorer: forWorkspace(Explorer, SIDE),
	search: forWorkspace(SearchPanel, SIDE),
	git: forWorkspace(GitPanel, SIDE),
	sessions: forWorkspace(SessionsPanel, SIDE),
	chat: forWorkspace(ChatPanel, ""),
	terminal: forWorkspace(TerminalDock, ""),
	brain: whole(BrainView),
	feed: whole(FeedView),
	agents: whole(AgentsView),
	browser: whole(BrowserView),
	server: whole(ServerView),
	automations: whole(AutomationsView),
};

export function Desk(): React.JSX.Element | null {
	const ready = useSettings((s) => !!s.settings);
	const locked = useSettings((s) => s.settings?.layout.locked ?? false);
	const detach = useRef<(() => void) | null>(null);

	useEffect(
		() => () => {
			detach.current?.();
			detach.current = null;
		},
		[],
	);

	if (!ready) return null;
	return (
		<DockviewReact
			className="teez-dock min-h-0 min-w-0 flex-1"
			theme={THEME}
			components={COMPONENTS}
			defaultTabComponent={PanelTab}
			rightHeaderActionsComponent={GroupActions}
			watermarkComponent={EmptyDesk}
			disableDnd={locked}
			getTabContextMenuItems={() => ["maximize", "float", "separator", "closeOthers", "close"]}
			onReady={(event) => {
				detach.current?.();
				detach.current = attachDesk(event.api);
			}}
		/>
	);
}

function PanelTab({ api }: IDockviewPanelHeaderProps): React.JSX.Element {
	const kind = isPanelKind(api.id) ? api.id : null;
	const Icon = kind ? PANEL_ICON[kind] : Files;
	return (
		<div
			className="teez-tab flex h-full items-center gap-1.5 pl-2.5 pr-1 font-condensed text-[12px] uppercase tracking-[0.12em]"
			title={`${api.title ?? ""} — drag to move it anywhere, right-click to float or maximize`}
			onAuxClick={(event) => {
				if (event.button !== 1) return;
				event.preventDefault();
				api.close();
			}}
		>
			<Icon size={13} strokeWidth={1.7} className="shrink-0" />
			<span className="teez-tab-label truncate">{kind ? PANEL_LABEL[kind] : api.title}</span>
			<button
				type="button"
				aria-label={`Close ${api.title ?? "panel"}`}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => {
					event.stopPropagation();
					api.close();
				}}
				className="teez-tab-close ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-muted hover:text-text"
			>
				<X size={11} />
			</button>
		</div>
	);
}

/** At the right of each group's tabs: float it, maximize it. */
function GroupActions({ api, containerApi, group }: IDockviewHeaderActionsProps): React.JSX.Element | null {
	const [maximized, setMaximized] = useState(() => api.isMaximized());
	useEffect(() => {
		const subscription = containerApi.onDidMaximizedGroupChange(() => setMaximized(api.isMaximized()));
		return () => subscription.dispose();
	}, [api, containerApi]);
	if (api.location.type !== "grid") return null;
	const button = "flex h-6 w-6 items-center justify-center text-muted hover:text-text";
	return (
		<div className="flex h-full items-center gap-0.5 px-1">
			{maximized ? null : (
				<button type="button" title="Float this group" aria-label="Float this group" className={button} onClick={() => containerApi.addFloatingGroup(group, FLOAT_SIZE)}>
					<PictureInPicture2 size={13} />
				</button>
			)}
			<button
				type="button"
				title={maximized ? "Restore" : "Maximize"}
				aria-label={maximized ? "Restore" : "Maximize"}
				className={button}
				onClick={() => (maximized ? api.exitMaximized() : api.maximize())}
			>
				{maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
			</button>
		</div>
	);
}

function EmptyDesk(_props: IWatermarkPanelProps): React.JSX.Element {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-4 bg-bg">
			<p className="font-display text-4xl tracking-wider text-muted/60">EMPTY DESK</p>
			<div className="flex max-w-md flex-wrap justify-center gap-2">
				{PANEL_KINDS.map((kind) => {
					const Icon = PANEL_ICON[kind];
					return (
						<button
							key={kind}
							type="button"
							onClick={() => revealPanel(kind)}
							className="flex items-center gap-1.5 cut-corner bg-surface px-3 py-1.5 font-condensed text-[11px] uppercase tracking-wider text-muted ring-1 ring-border hover:text-text hover:ring-red/50"
						>
							<Icon size={13} />
							{PANEL_LABEL[kind]}
						</button>
					);
				})}
			</div>
		</div>
	);
}

function NoProject(): React.JSX.Element {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
			<p className="font-display text-2xl tracking-wider text-muted/60">NO PROJECT</p>
			<button
				type="button"
				onClick={() => void window.teez.workspaces.pin()}
				className="cut-corner bg-red px-4 py-1.5 font-condensed text-xs uppercase tracking-wider"
			>
				Pin a folder
			</button>
		</div>
	);
}
