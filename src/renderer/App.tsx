import { useEffect, useState } from "react";
import { claudeUsageOf } from "./state/usage-event.ts";
import { MotionConfig } from "framer-motion";
import type { TeezApi, ClaudeStatus } from "../preload/index.ts";
import { activeWorkspaceIdOf, useSettings } from "./state/settings.ts";
import { useUi } from "./state/ui.ts";
import { useTree } from "./state/tree.ts";
import { useChats } from "./state/chats.ts";
import { useEditor } from "./state/editor.ts";
import { useAgents } from "./state/agents.ts";
import { useBrain } from "./state/brain.ts";
import { startUsagePolling, useUsage, usageMayHaveChanged } from "./state/usage.ts";
import { sampleUsage } from "./state/usage-sample.ts";
import { treeWants, useAgentTree } from "./state/agent-tree.ts";
import { sampleAgentTree } from "./agents/sample.ts";
import { TitleBar } from "./shell/TitleBar.tsx";
import { ActivityBar } from "./shell/ActivityBar.tsx";
import { StatusBar } from "./shell/StatusBar.tsx";
import { ContextMenu, Toasts } from "./shell/Overlays.tsx";
import { Palette } from "./shell/Palette.tsx";
import { closeActiveTab, saveActive, togglePreviewActive } from "./shell/commands.ts";
import { installSideNav } from "./shell/side-nav.ts";
import { installUniversalMenu } from "./shell/install-universal-menu.ts";
import { cycleDesk, newDesk, openWorkspace, revealPanel, showView, switchDesk, togglePanel } from "./shell/dock-actions.ts";
import { Desk } from "./shell/Desk.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { OnboardingModal } from "./onboarding/OnboardingModal.tsx";
import { VIEW_IDS, VIEW_MODULE } from "../shared/views.ts";
import { isModuleEnabled } from "../shared/modules.ts";
import { isSettingsPage } from "./views/settings/nav.ts";
import { wireBrowser } from "./browser/open.ts";

declare global {
	interface Window {
		readonly teez: TeezApi;
		/** Dev builds only: the window capture (src/main/dev-capture.ts) shows a view before photographing it. */
		__teezShowView?: (view: string) => void;
	}
}

if (import.meta.env.DEV) {
	window.__teezShowView = (view) => {
		const ui = useUi.getState();
		// The capture sends no message, so no Claude session reports limits: show sample rails instead.
		if (useUsage.getState().usage === null) useUsage.setState({ usage: sampleUsage(Date.now()) });
		if (view === "onboarding") {
			ui.setView("desk");
			ui.setDialog("onboarding");
			return;
		}
		if (view === "settings") {
			ui.setView("settings");
			return;
		}
		if (view.startsWith("settings:")) {
			const page = view.slice("settings:".length);
			if (isSettingsPage(page)) ui.openSettings(page);
			return;
		}
		// The chat panel brought to the front, where the usage rails sit beside the composer.
		// A Claude chat in front, so the rails show at full strength rather than dimmed for Gemini.
		if (view === "chat") {
			ui.setView("desk");
			revealPanel("chat");
			const workspaceId = activeWorkspaceIdOf(useSettings.getState().settings);
			const chats = useChats.getState();
			const current = workspaceId ? chats.chats[chats.activeByWorkspace[workspaceId] ?? ""] : undefined;
			if (workspaceId && current?.agent !== "claude") void chats.openChat(workspaceId, { agent: "claude" });
			return;
		}
		if (view === "brain:graph") {
			ui.setView("desk");
			showView("brain");
			// After the view has opened its first note (which puts it in note mode).
			setTimeout(() => useBrain.getState().setMode("graph"), 600);
			return;
		}
		if (!(VIEW_IDS as readonly string[]).includes(view)) return;
		ui.setView("desk");
		// The capture shows a populated Agents view rather than the empty state.
		if (view === "agents" && useAgentTree.getState().tree.order.length === 0) useAgentTree.setState({ tree: sampleAgentTree(Date.now()) });
		showView(view as (typeof VIEW_IDS)[number]);
	};
}

/**
 * The window: title bar with the desks, activity bar, the desk (every panel
 * lives there; Settings opens over it) and a status line. Main-process events
 * are wired once here and fanned out into the stores.
 */
export function App(): React.JSX.Element {
	const bridge: TeezApi | undefined = window.teez;

	// Without the preload there is no way to reach the main process, and every
	// component below would throw on first render — which showed up as a window
	// painted in nothing but the background colour. Say what happened instead.
	if (!bridge) return <BridgeMissing />;
	// "user": transforms stop for anyone who asked their system for reduced motion.
	return (
		<MotionConfig reducedMotion="user">
			<Shell />
		</MotionConfig>
	);
}

function Shell(): React.JSX.Element {
	const view = useUi((s) => s.view);
	const dialog = useUi((s) => s.dialog);
	const onboardingCompleted = useSettings((s) => s.settings?.onboardingCompleted);
	const [claude, setClaude] = useState<ClaudeStatus | null>(null);

	useEffect(() => {
		if (onboardingCompleted === false && useUi.getState().dialog === null) {
			useUi.getState().setDialog("onboarding");
		}
	}, [onboardingCompleted]);

	useEffect(() => {
		void useSettings.getState().load();
		void useAgents.getState().load();
		void window.teez.chat.claudeStatus().then(setClaude);
		const stopUsage = startUsagePolling();

		const offEvent = window.teez.chat.onEvent((envelope) => {
			const event = envelope.event;
			// Only a Claude chat's limits are Claude's plan usage (Codex reports its own).
			const usage = claudeUsageOf(event, useChats.getState().chats[envelope.chatId]?.agent);
			if (usage) useAgents.getState().setUsage(usage);
			// A Claude or Antigravity turn spends from the plan limits; a session starting is the first that can report them.
			const chatAgent = useChats.getState().chats[envelope.chatId]?.agent;
			if ((event.kind === "turn-end" || event.kind === "session-ready") && (chatAgent === "claude" || chatAgent === "agy")) {
				usageMayHaveChanged();
			}
			useChats.getState().handleEvent(envelope);
			// The Agents view: only events that can change its tree (never a delta of a chat already running).
			if (treeWants(envelope.chatId, event)) {
				const chat = useChats.getState().chats[envelope.chatId];
				// Closed chats are dropped by the chats store; their late events are dropped here too.
				if (chat) {
					useAgentTree.getState().apply(
						{ chatId: chat.chatId, title: chat.title, agent: chat.agent, model: chat.model || (chat.agent === "claude" ? "opus" : "") },
						event,
					);
				}
			}
		});
		// A chat closed mid-turn sends nothing more: end what it was running. Closing changes the tab order,
		// which streaming does not, so this does no work per token.
		const offChats = useChats.subscribe((state, previous) => {
			if (state.orderByWorkspace === previous.orderByWorkspace) return;
			for (const chatId of Object.keys(previous.chats)) {
				if (!state.chats[chatId]) useAgentTree.getState().endChat(chatId);
			}
		});
		const offApproval = window.teez.chat.onApproval((envelope) => useChats.getState().handleApproval(envelope));
		const offPause = window.teez.chat.onPause((change) => useChats.getState().handlePause(change));
		const offFs = window.teez.files.onChange((change) => {
			useTree.getState().refresh(change.workspaceId, change.dirs);
			if (change.git) void useTree.getState().refreshGit(change.workspaceId);
			void useEditor.getState().reloadChanged(change.workspaceId, change.dirs);
			// A change in the vault (an agent writing a note, a git pull) refreshes Brain.
			const settings = useSettings.getState().settings;
			const workspace = settings?.workspaces.find((w) => w.id === change.workspaceId);
			const isVault = !!workspace && !!settings?.vaultPath && workspace.path.toLowerCase() === settings.vaultPath.toLowerCase();
			if (isVault && change.dirs.length > 0 && useBrain.getState().index) void useBrain.getState().refresh();
		});
		// A click on a chat notification shows that chat in its workspace.
		const offFocus = window.teez.chat.onFocus(({ chatId, workspaceId }) => {
			openWorkspace(workspaceId);
			useChats.getState().activate(workspaceId, chatId);
			revealPanel("chat");
		});
		// A click on a server notification opens the Server view.
		const offServer = window.teez.server.onOpen(() => revealPanel("server"));
		// A click on a "run finished" notification opens that run.
		const offRun = window.teez.automations.onOpenRun((runId) => {
			useUi.getState().setPendingRun(runId);
			revealPanel("automations");
		});
		// The built-in browser's pages report in here, whether or not its panel is open.
		const offBrowser = wireBrowser();
		return () => {
			stopUsage();
			offEvent();
			offChats();
			offApproval();
			offPause();
			offFs();
			offRun();
			offFocus();
			offServer();
			offBrowser();
		};
	}, []);

	useEffect(() => installSideNav(), []);
	useEffect(() => installUniversalMenu(), []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			const ctrl = event.ctrlKey || event.metaKey;
			const key = event.key.toLowerCase();
			const ui = useUi.getState();
			if (ctrl && !event.shiftKey && key === "p") {
				event.preventDefault();
				ui.openPalette("files");
			} else if (ctrl && (key === "k" || (event.shiftKey && key === "p"))) {
				event.preventDefault();
				ui.openPalette("commands");
			} else if (ctrl && key === "`") {
				event.preventDefault();
				togglePanel("terminal");
			} else if (ctrl && !event.shiftKey && key === "b") {
				event.preventDefault();
				togglePanel("explorer");
			} else if (ctrl && !event.shiftKey && key === "j") {
				event.preventDefault();
				togglePanel("chat");
			} else if (ctrl && !event.shiftKey && key === "s") {
				event.preventDefault();
				void saveActive();
			} else if (ctrl && event.shiftKey && key === "v" && ui.view === "desk") {
				// Only from the editor or the page itself: in the chat it stays a paste.
				const focus = document.activeElement;
				const typing = (focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement) && !focus.closest(".monaco-editor");
				if (!typing && togglePreviewActive()) event.preventDefault();
			} else if (ctrl && !event.shiftKey && key === "w") {
				event.preventDefault();
				closeActiveTab();
			} else if (ctrl && event.shiftKey && key === "f") {
				event.preventDefault();
				revealPanel("search");
			} else if (ctrl && key === ",") {
				event.preventDefault();
				ui.setView(ui.view === "settings" ? "desk" : "settings");
			} else if (key === "escape" && ui.view === "settings" && !event.defaultPrevented) {
				// An input in Settings that handled Escape (cancelling a rename) keeps Settings open.
				ui.setView("desk");
			} else if (ctrl && ["1", "2", "3", "4", "5", "6", "7"].includes(key)) {
				event.preventDefault();
				// A view whose module is turned off is not shown (revealPanel refuses its panel too).
				const target = VIEW_IDS[Number(key) - 1] ?? "code";
				const modules = useSettings.getState().settings?.modules;
				if (!modules || isModuleEnabled(modules, VIEW_MODULE[target])) showView(target);
			} else if (ctrl && !event.shiftKey && key === "t") {
				event.preventDefault();
				newDesk();
			} else if (ctrl && key === "tab") {
				event.preventDefault();
				cycleDesk(event.shiftKey ? -1 : 1);
			} else if (event.altKey && /^[1-9]$/.test(event.key)) {
				const desks = useSettings.getState().settings?.layout.desks;
				const target = desks?.[Number(event.key) - 1];
				if (target) {
					event.preventDefault();
					switchDesk(target.id);
				}
			}
		};
		const toggleTerminal = (): void => togglePanel("terminal");
		window.addEventListener("keydown", onKey);
		window.addEventListener("teez:toggle-terminal", toggleTerminal);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("teez:toggle-terminal", toggleTerminal);
		};
	}, []);


	return (
		<div className="flex h-full flex-col text-text">
			<TitleBar />
			{claude && !claude.ok ? (
				<div className="border-b border-red/40 bg-red/10 px-4 py-1.5 font-mono text-[11px]">
					Claude Code was not found: {claude.reason}
				</div>
			) : null}
			<div className="flex min-h-0 flex-1">
				<ActivityBar />
				<main className="relative flex min-h-0 min-w-0 flex-1">
					<Desk />
					{view === "settings" ? (
						<div className="absolute inset-0 z-20 flex bg-bg">
							<SettingsView />
						</div>
					) : null}
				</main>
			</div>
			<StatusBar />
			<Palette />
			<ContextMenu />
			<Toasts />
			{dialog === "onboarding" ? (
				<OnboardingModal onClose={() => useUi.getState().setDialog(null)} />
			) : null}
		</div>
	);
}

function BridgeMissing(): React.JSX.Element {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-8 text-center">
			<p className="font-display text-2xl tracking-wider text-red">PRELOAD DID NOT LOAD</p>
			<p className="max-w-md font-mono text-xs leading-relaxed text-muted">
				The window has no bridge to the main process, so nothing can run. This is a build problem: the
				preload must be CommonJS at <span className="text-[#f5f0f2]">out/preload/index.cjs</span>, and
				the main process must point at that file.
			</p>
		</div>
	);
}
