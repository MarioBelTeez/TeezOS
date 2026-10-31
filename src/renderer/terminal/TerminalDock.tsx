import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, Plus, Server, TerminalSquare, Trash2, X } from "lucide-react";
import type { Workspace } from "../../main/settings/store.ts";
import type { TerminalProfile } from "../../main/terminal/service.ts";
import { useUi } from "../state/ui.ts";
import { useSettings } from "../state/settings.ts";
import { DEFAULT_MODULES } from "../../shared/modules.ts";
import { IconButton } from "../shell/IconButton.tsx";
import { terminalKeyHandler } from "./keys.ts";

/**
 * The terminal dock: real shells in tabs, per workspace. A terminal keeps
 * running (and keeps its scrollback) while hidden, so switching workspace or
 * closing the dock never kills a long command.
 */

type Tab = {
	readonly id: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly profile: TerminalProfile;
	/** The container a "ssh-ct" tab is in, so a restart reopens the same one. */
	readonly vmid?: number;
	/** The Claude session a "claude-resume-remote" tab resumed, so a restart resumes it again. */
	readonly sessionId?: string;
	readonly exited: boolean;
};

type TerminalsState = {
	readonly tabs: readonly Tab[];
	/** Terminals being started per workspace, so the dock does not start another. */
	readonly opening: Readonly<Record<string, number>>;
	readonly activeByWorkspace: Readonly<Record<string, string>>;
	/** True once the terminal is running. */
	readonly open: (workspaceId: string, profile?: TerminalProfile, vmid?: number, sessionId?: string) => Promise<boolean>;
	readonly close: (id: string) => void;
	readonly activate: (workspaceId: string, id: string) => void;
	readonly markExited: (id: string) => void;
};

type Instance = { readonly term: Terminal; readonly fit: FitAddon; readonly element: HTMLDivElement };
const instances = new Map<string, Instance>();

const THEME = {
	background: "#08060a",
	foreground: "#f5f0f2",
	cursor: "#e8002d",
	cursorAccent: "#08060a",
	selectionBackground: "#e8002d55",
	black: "#1c1418",
	red: "#ff3b5c",
	green: "#73c991",
	yellow: "#f5a524",
	blue: "#75beff",
	magenta: "#c586c0",
	cyan: "#5fd7d7",
	white: "#d8cdd2",
	brightBlack: "#6b5b62",
	brightRed: "#ff6b84",
	brightGreen: "#9be3b4",
	brightYellow: "#ffc861",
	brightBlue: "#a5d4ff",
	brightMagenta: "#e0a8dc",
	brightCyan: "#8ff0f0",
	brightWhite: "#ffffff",
};

function terminalOptions(): { readonly fontSize: number; readonly cursorBlink: boolean } {
	const options = useSettings.getState().settings?.modules.terminal ?? DEFAULT_MODULES.terminal;
	return { fontSize: options.fontSize, cursorBlink: options.cursorBlink };
}

function makeInstance(id: string): Instance {
	const element = document.createElement("div");
	element.className = "absolute inset-0 px-2 pt-1";
	const term = new Terminal({
		// The user's Nerd Font first (prompts like oh-my-posh draw their
		// powerline glyphs from it), then the bundled DM Mono.
		fontFamily: '"JetBrainsMono Nerd Font", "JetBrainsMonoNL Nerd Font", "CaskaydiaCove Nerd Font", "DM Mono", ui-monospace, monospace',
		...terminalOptions(),
		lineHeight: 1.15,
		cursorStyle: "bar",
		scrollback: 8000,
		allowProposedApi: false,
		theme: THEME,
	});
	const fit = new FitAddon();
	term.loadAddon(fit);
	term.onData((data) => {
		const tab = useTerminals.getState().tabs.find((t) => t.id === id);
		if (tab?.exited) {
			if (data === "\r") void restart(tab);
			return;
		}
		window.teez.terminal.write(id, data);
	});
	term.onResize(({ cols, rows }) => window.teez.terminal.resize(id, cols, rows));
	// Ctrl+C copies when there is a selection, Ctrl+V pastes — as Windows Terminal does.
	term.attachCustomKeyEventHandler(terminalKeyHandler(term));
	term.open(element);
	return { term, fit, element };
}

async function restart(tab: Tab): Promise<void> {
	useTerminals.getState().close(tab.id);
	await useTerminals.getState().open(tab.workspaceId, tab.profile, tab.vmid, tab.sessionId);
}

/** Settings → Terminal, live: open terminals take a new font size or cursor blink at once, and refit to it. */
function applyTerminalOptions(): void {
	const { fontSize, cursorBlink } = terminalOptions();
	for (const { term, fit, element } of instances.values()) {
		if (term.options.fontSize === fontSize && term.options.cursorBlink === cursorBlink) continue;
		term.options.fontSize = fontSize;
		term.options.cursorBlink = cursorBlink;
		if (!element.isConnected) continue;
		try {
			fit.fit();
		} catch {
			// not laid out yet; the dock fits it when shown
		}
	}
}

let wired = false;
function wireEvents(): void {
	if (wired) return;
	wired = true;
	useSettings.subscribe((state, previous) => {
		if (state.settings?.modules.terminal !== previous.settings?.modules.terminal) applyTerminalOptions();
	});
	window.teez.terminal.onData(({ id, data }) => instances.get(id)?.term.write(data));
	window.teez.terminal.onExit(({ id, exitCode }) => {
		instances.get(id)?.term.write(`\r\n\x1b[38;2;107;91;98m[process exited with code ${exitCode} — press Enter to restart]\x1b[0m\r\n`);
		useTerminals.getState().markExited(id);
	});
}

export const useTerminals = create<TerminalsState>((set, get) => ({
	tabs: [],
	opening: {},
	activeByWorkspace: {},

	open: async (workspaceId, profile = "shell", vmid, sessionId) => {
		wireEvents();
		const bump = (by: number): void =>
			set({ opening: { ...get().opening, [workspaceId]: Math.max(0, (get().opening[workspaceId] ?? 0) + by) } });
		bump(1);
		let result: Awaited<ReturnType<typeof window.teez.terminal.create>>;
		try {
			// A plain shell tab runs the shell picked in Settings → Terminal; the main process checks the choice.
			const shell = useSettings.getState().settings?.modules.terminal.shell ?? "auto";
			result = await window.teez.terminal.create({ workspaceId, profile, cols: 100, rows: 24, shell, ...(vmid ? { vmid } : {}), ...(sessionId ? { sessionId } : {}) });
		} finally {
			bump(-1);
		}
		if (!result) return false;
		if ("error" in result) {
			useUi.getState().toast(`Terminal failed to start: ${result.error}`, "error");
			return false;
		}
		instances.set(result.id, makeInstance(result.id));
		set({
			tabs: [...get().tabs, { id: result.id, workspaceId, title: result.title, profile, ...(vmid ? { vmid } : {}), ...(sessionId ? { sessionId } : {}), exited: false }],
			activeByWorkspace: { ...get().activeByWorkspace, [workspaceId]: result.id },
		});
		return true;
	},

	close: (id) => {
		const tab = get().tabs.find((t) => t.id === id);
		window.teez.terminal.kill(id);
		instances.get(id)?.term.dispose();
		instances.get(id)?.element.remove();
		instances.delete(id);
		const tabs = get().tabs.filter((t) => t.id !== id);
		const activeByWorkspace = { ...get().activeByWorkspace };
		if (tab && activeByWorkspace[tab.workspaceId] === id) {
			const next = tabs.filter((t) => t.workspaceId === tab.workspaceId).at(-1);
			if (next) activeByWorkspace[tab.workspaceId] = next.id;
			else delete activeByWorkspace[tab.workspaceId];
		}
		set({ tabs, activeByWorkspace });
	},

	activate: (workspaceId, id) => set({ activeByWorkspace: { ...get().activeByWorkspace, [workspaceId]: id } }),

	markExited: (id) => set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, exited: true } : t)) }),
}));

const PROFILE_LABELS: Readonly<Record<Exclude<TerminalProfile, "ssh-ct" | "claude-setup-token" | "claude-resume-remote">, string>> = {
	shell: "Shell (as set in Settings → Terminal)",
	"ssh-pve": "SSH to the server (pve)",
	"claude-login": "Claude Code (log in / interactive)",
	agy: "Antigravity CLI",
	"claude-remote": "Remote Control: new Claude sessions from your phone",
};

export function TerminalDock({ workspace }: { readonly workspace: Workspace }): React.JSX.Element {
	const tabs = useTerminals(useShallow((s) => s.tabs.filter((t) => t.workspaceId === workspace.id)));
	const activeId = useTerminals((s) => s.activeByWorkspace[workspace.id]);
	const { open, close, activate } = useTerminals.getState();
	const host = useRef<HTMLDivElement>(null);

	// The first time the dock opens on a workspace, start a shell there — unless
	// one is already on its way (an SSH tab opened from the Server view, a
	// login), or React's dev double-render asks twice.
	useEffect(() => {
		const state = useTerminals.getState();
		const has = state.tabs.some((t) => t.workspaceId === workspace.id);
		if (!has && !(state.opening[workspace.id] ?? 0)) void open(workspace.id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspace.id]);

	// Show the active terminal's element, fitted to the dock.
	useEffect(() => {
		const container = host.current;
		if (!container || !activeId) return;
		const instance = instances.get(activeId);
		if (!instance) return;
		for (const child of [...container.children]) {
			if (child !== instance.element) child.remove();
		}
		if (instance.element.parentElement !== container) container.appendChild(instance.element);
		const fitNow = (): void => {
			try {
				instance.fit.fit();
			} catch {
				// not laid out yet
			}
		};
		fitNow();
		instance.term.focus();
		const observer = new ResizeObserver(fitNow);
		observer.observe(container);
		return () => observer.disconnect();
	}, [activeId, tabs.length]);

	const terminalMenu = (event: React.MouseEvent): void => {
		event.preventDefault();
		const instance = activeId ? instances.get(activeId) : undefined;
		if (!instance || !activeId) return;
		const { term } = instance;
		const selection = term.getSelection();
		useUi.getState().openMenu(event.clientX, event.clientY, [
			{
				label: "Copy",
				hint: "Ctrl+C",
				disabled: !selection,
				onSelect: () => {
					void navigator.clipboard.writeText(selection);
					term.clearSelection();
					term.focus();
				},
			},
			{
				label: "Paste",
				hint: "Ctrl+V",
				onSelect: () => {
					// Bracketed paste, as Ctrl+V: a multi-line command lands in the prompt instead of running.
					void navigator.clipboard.readText().then((text) => {
						term.paste(text);
						term.focus();
					});
				},
			},
			{ label: "Select all", onSelect: () => term.selectAll() },
			{ label: "Clear", onSelect: () => term.clear() },
			{ separator: true },
			{ label: "New terminal", onSelect: () => void open(workspace.id) },
			{ label: "Kill terminal", danger: true, onSelect: () => close(activeId) },
		]);
	};

	const profileMenu = (event: React.MouseEvent): void => {
		const rect = event.currentTarget.getBoundingClientRect();
		useUi.getState().openMenu(
			rect.left,
			rect.top - 4 - 4 * 26,
			(Object.keys(PROFILE_LABELS) as (keyof typeof PROFILE_LABELS)[]).map((profile) => ({
				label: PROFILE_LABELS[profile],
				onSelect: () => void open(workspace.id, profile),
			})),
		);
	};

	return (
		<section className="flex h-full min-h-0 flex-col bg-bg">
			<div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-surface pl-3 pr-1">
				<TerminalSquare size={13} className="text-muted" />
				<div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]">
					{tabs.map((tab, index) => (
						<div
							key={tab.id}
							role="tab"
							aria-selected={tab.id === activeId}
							onClick={() => activate(workspace.id, tab.id)}
							className={`group relative flex h-8 cursor-pointer items-center gap-2 px-3 font-mono text-[11px] ${
								tab.id === activeId ? "text-text" : "text-muted hover:text-text"
							}`}
						>
							{tab.id === activeId ? <span className="absolute inset-x-2 bottom-0 h-[2px] bg-red" /> : null}
							{tab.profile === "ssh-pve" ? <Server size={11} /> : null}
							<span className={tab.exited ? "line-through opacity-60" : ""}>
								{index + 1}: {tab.title}
							</span>
							<button
								type="button"
								aria-label="Close terminal"
								onClick={(event) => {
									event.stopPropagation();
									close(tab.id);
								}}
								className="opacity-0 group-hover:opacity-100 hover:text-red"
							>
								<X size={11} />
							</button>
						</div>
					))}
				</div>
				<IconButton label="New terminal" onClick={() => void open(workspace.id)}>
					<Plus size={14} />
				</IconButton>
				<button
					type="button"
					title="Open a terminal profile"
					onClick={profileMenu}
					className="flex h-7 w-5 items-center justify-center text-muted hover:text-text"
				>
					<ChevronDown size={13} />
				</button>
				{activeId ? (
					<IconButton label="Kill terminal" onClick={() => close(activeId)}>
						<Trash2 size={13} />
					</IconButton>
				) : null}
			</div>
			<div ref={host} onContextMenu={terminalMenu} className="relative min-h-0 flex-1" />
		</section>
	);
}
