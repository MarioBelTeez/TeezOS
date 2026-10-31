import { useEffect, useState } from "react";
import { LayoutPanelTop, Lock, Search } from "lucide-react";
import type { UpdateStatus } from "../../main/update/updater.ts";
import { PANEL_KINDS } from "../../shared/desks.ts";
import { useActiveWorkspace, useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { useAgents } from "../state/agents.ts";
import { DeskTabs } from "./DeskTabs.tsx";
import { PresetPicker } from "./PresetPicker.tsx";
import { panelEnabled } from "../../shared/views.ts";
import { closePanel, PANEL_LABEL, resetLayout, revealPanel, toggleLock, useDesk } from "./dock-actions.ts";
import logo from "../assets/logo.png";

/** The frame is ours to draw: wordmark, the desks, a search box, the panels menu, window buttons. */
export function TitleBar(): React.JSX.Element {
	const workspace = useActiveWorkspace();
	const workspaceName = workspace?.name ?? "";
	const openPalette = useUi((s) => s.openPalette);

	return (
		<header className="drag-region glass relative flex h-10 shrink-0 items-stretch border-b border-border">
			{/* A red light along the bottom edge, brightest under the desks. */}
			<span className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-linear-to-r from-transparent via-red/60 to-transparent" />
			<div className="flex shrink-0 items-center gap-2 px-3">
				<img src={logo} className="glow-icon h-5 w-5" alt="" />
				<span className="glow-text font-display text-lg tracking-wider">{workspaceName.toUpperCase()}</span>
			</div>
			<DeskTabs />
			<PresetPicker />
			<div className="min-w-6 flex-1" />

			<button
				type="button"
				onClick={() => openPalette("files")}
				className="no-drag my-2 flex w-[min(300px,24vw)] shrink-0 items-center gap-2 border border-border bg-black/40 px-2 font-mono text-[11px] text-muted transition-[color,border-color,box-shadow] hover:border-red/60 hover:text-text hover:shadow-[0_0_14px_var(--color-glow)]"
			>
				<Search size={12} />
				<span className="flex-1 truncate text-left">
					Search files{workspace ? ` in ${workspace.name}` : ""}
				</span>
				<span className="text-[10px]">Ctrl+P</span>
			</button>
			<PanelsMenu />

			<div className="flex h-full items-center gap-3 pl-2">
				<UsageMeter />
				<UpdateBadge />
				<div className="no-drag flex h-full">
					<WindowButton label="Minimize" onClick={() => window.teez.window.minimize()}>
						&#8211;
					</WindowButton>
					<WindowButton label="Maximize" onClick={() => window.teez.window.toggleMaximize()}>
						&#9633;
					</WindowButton>
					<WindowButton label="Close" onClick={() => window.teez.window.close()} danger>
						&#10005;
					</WindowButton>
				</div>
			</div>
		</header>
	);
}

/** Like OBS's Docks menu: every panel, ticked when it is on this desk; click to open or close it. */
function PanelsMenu(): React.JSX.Element {
	const open = useDesk((s) => s.open);
	const locked = useSettings((s) => s.settings?.layout.locked ?? false);
	const modules = useSettings((s) => s.settings?.modules);
	return (
		<button
			type="button"
			title="Panels on this desk"
			aria-label="Panels on this desk"
			onClick={(event) => {
				const rect = event.currentTarget.getBoundingClientRect();
				useUi.getState().openMenu(rect.left - 120, rect.bottom + 2, [
					// A module that is turned off is not offered.
					...PANEL_KINDS.filter((kind) => !modules || panelEnabled(kind, modules)).map((kind) => ({
						label: PANEL_LABEL[kind],
						hint: open.includes(kind) ? "on desk" : "",
						onSelect: () => (open.includes(kind) ? closePanel(kind) : revealPanel(kind)),
					})),
					{ separator: true },
					{ label: locked ? "Unlock the layout" : "Lock the layout", onSelect: toggleLock },
					{ label: "Reset this desk's layout", onSelect: resetLayout },
				]);
			}}
			className="no-drag ml-2 flex w-8 shrink-0 items-center justify-center text-muted hover:text-text"
		>
			{locked ? <Lock size={14} /> : <LayoutPanelTop size={15} />}
		</button>
	);
}

/**
 * Claude's rate-limit window as last reported by a run: which window, whether
 * it is close, and when it resets. Silent until the first report arrives.
 */
function UsageMeter(): React.JSX.Element | null {
	const usage = useAgents((s) => s.usage);
	if (!usage) return null;
	const windowName = usage.window
		.replace("five_hour", "5h")
		.replace("seven_day_opus", "7d opus")
		.replace("seven_day", "7d")
		.replace(/_/g, " ");
	// resetsAt arrives in seconds since the epoch.
	const resets = usage.resetsAt ? new Date(usage.resetsAt < 1e12 ? usage.resetsAt * 1000 : usage.resetsAt) : null;
	const tone = usage.status === "rejected" ? "text-red" : usage.status.includes("warning") ? "text-amber" : "text-muted";
	return (
		<span
			className={`no-drag font-mono text-[10px] ${tone}`}
			title={`Claude usage: ${usage.status}${resets ? `, resets ${resets.toLocaleString()}` : ""}`}
		>
			{windowName} · {usage.status === "allowed" ? "ok" : usage.status.replace(/_/g, " ")}
			{resets ? ` · ${resets.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
		</span>
	);
}

/**
 * Quiet by design: it says nothing while the app is current, off, or merely
 * checking. A new version only interrupts once it is downloaded and one click
 * away — and even then it waits for that click, because a restart in the
 * middle of a turn would throw away work.
 */
function UpdateBadge(): React.JSX.Element | null {
	const [status, setStatus] = useState<UpdateStatus | null>(null);

	useEffect(() => {
		void window.teez.updates.status().then(setStatus);
		return window.teez.updates.onStatus(setStatus);
	}, []);

	if (!status) return null;
	if (status.state === "ready") {
		return (
			<button
				type="button"
				onClick={() => window.teez.updates.install()}
				className="no-drag cut-corner btn-hot px-3 py-1 font-condensed text-[11px] uppercase tracking-wider text-white"
			>
				Restart for {status.version}
			</button>
		);
	}
	if (status.state === "downloading") {
		return <span className="font-mono text-[10px] text-muted">updating {status.percent}%</span>;
	}
	if (status.state === "available") {
		return <span className="font-mono text-[10px] text-muted">{status.version} downloading…</span>;
	}
	return null;
}

function WindowButton({
	label,
	onClick,
	danger = false,
	children,
}: {
	readonly label: string;
	readonly onClick: () => void;
	readonly danger?: boolean;
	readonly children: React.ReactNode;
}): React.JSX.Element {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={onClick}
			className={`w-12 text-sm text-muted transition-colors hover:text-text ${
				danger ? "hover:bg-red" : "hover:bg-border"
			}`}
		>
			{children}
		</button>
	);
}
