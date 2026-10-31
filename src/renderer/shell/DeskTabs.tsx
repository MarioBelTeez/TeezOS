import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { deskTitle, type Desk } from "../../shared/desks.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { useWorkspaceIcons } from "../state/icons.ts";
import { initials } from "./ActivityBar.tsx";
import { closeDesk, moveDesk, newDesk, renameDesk, switchDesk } from "./dock-actions.ts";

/**
 * The desks along the top, like browser tabs: one per thing on the go, each
 * with its own project and its own layout. Drag to reorder, double-click to
 * rename, middle-click to close; + opens another.
 */

const DESK_DRAG = "application/x-teez-desk";

export function DeskTabs(): React.JSX.Element | null {
	const settings = useSettings((s) => s.settings);
	const layout = settings?.layout;
	const workspaces = settings?.workspaces ?? [];
	const icons = useWorkspaceIcons((s) => s.byId);
	const [editing, setEditing] = useState<string | null>(null);
	// Logos load when the pinned folders (or their icon choice) change; Settings → Projects shows them too.
	const iconKey = workspaces.map((w) => `${w.id}:${w.icon ?? ""}`).join("|");
	useEffect(() => {
		void useWorkspaceIcons.getState().load(iconKey ? iconKey.split("|").map((entry) => entry.split(":")[0] ?? "") : []);
	}, [iconKey]);
	const [dropMark, setDropMark] = useState<{ id: string; after: boolean } | null>(null);
	if (!layout) return null;

	const rightHalf = (event: React.DragEvent): boolean => {
		const rect = event.currentTarget.getBoundingClientRect();
		return event.clientX > rect.left + rect.width / 2;
	};

	const menu = (event: React.MouseEvent, desk: Desk): void => {
		event.preventDefault();
		useUi.getState().openMenu(event.clientX, event.clientY, [
			{ label: "Rename", onSelect: () => setEditing(desk.id) },
			{
				label: "Duplicate",
				onSelect: () => {
					switchDesk(desk.id);
					newDesk(desk.workspaceId);
				},
			},
			{ separator: true },
			...(layout.desks.length > 1
				? [
						{ label: "Close others", onSelect: () => layout.desks.filter((d) => d.id !== desk.id).forEach((d) => closeDesk(d.id)) },
						{ label: "Close", danger: true, hint: "middle-click", onSelect: () => closeDesk(desk.id) },
					]
				: []),
		]);
	};

	return (
		<div className="no-drag flex h-full min-w-0 items-stretch overflow-x-auto" role="tablist" aria-label="Desks">
			{layout.desks.map((desk) => {
				const active = desk.id === layout.activeDeskId;
				const workspace = workspaces.find((w) => w.id === desk.workspaceId);
				const title = deskTitle(desk, workspaces);
				const icon = icons[desk.workspaceId] ?? null;
				return (
					<div
						key={desk.id}
						role="tab"
						aria-selected={active}
						data-desk={desk.id}
						draggable={editing !== desk.id}
						title={`${title}${workspace ? `\n${workspace.path}` : ""}\nDouble-click to rename, middle-click to close`}
						onClick={() => switchDesk(desk.id)}
						onDoubleClick={() => setEditing(desk.id)}
						onAuxClick={(event) => {
							if (event.button !== 1) return;
							event.preventDefault();
							closeDesk(desk.id);
						}}
						onContextMenu={(event) => menu(event, desk)}
						onDragStart={(event) => {
							event.dataTransfer.setData(DESK_DRAG, desk.id);
							event.dataTransfer.effectAllowed = "move";
						}}
						onDragOver={(event) => {
							if (!event.dataTransfer.types.includes(DESK_DRAG)) return;
							event.preventDefault();
							const after = rightHalf(event);
							if (dropMark?.id !== desk.id || dropMark.after !== after) setDropMark({ id: desk.id, after });
						}}
						onDragLeave={() => setDropMark((m) => (m?.id === desk.id ? null : m))}
						onDrop={(event) => {
							const moved = event.dataTransfer.getData(DESK_DRAG);
							setDropMark(null);
							if (!moved) return;
							event.preventDefault();
							moveDesk(moved, desk.id, rightHalf(event));
						}}
						onDragEnd={() => setDropMark(null)}
						className={`group relative flex min-w-0 max-w-[200px] shrink-0 cursor-default items-center gap-2 border-r border-border pl-3 pr-1.5 transition-colors ${
							active ? "tab-active bg-surface-2/80 text-text" : "text-muted hover:bg-white/[0.03] hover:text-text"
						}`}
					>
						{dropMark?.id === desk.id ? (
							<span className={`pointer-events-none absolute inset-y-1 w-[2px] bg-red ${dropMark.after ? "-right-px" : "-left-px"}`} />
						) : null}
						{icon ? (
							<img src={icon} alt="" draggable={false} className={`h-4 w-4 shrink-0 object-contain ${active ? "glow-icon" : ""}`} />
						) : (
							<span className={`shrink-0 font-display text-[13px] leading-none tracking-wider ${active ? "glow-text text-red-hot" : ""}`}>{initials(workspace?.name ?? title)}</span>
						)}
						{editing === desk.id ? (
							<input
								autoFocus
								defaultValue={desk.name || title}
								aria-label="Desk name"
								onClick={(event) => event.stopPropagation()}
								onKeyDown={(event) => {
									if (event.key === "Enter") event.currentTarget.blur();
									if (event.key === "Escape") setEditing(null);
								}}
								onBlur={(event) => {
									if (editing === desk.id) renameDesk(desk.id, event.currentTarget.value === workspace?.name ? "" : event.currentTarget.value);
									setEditing(null);
								}}
								className="w-28 min-w-0 border border-red/50 bg-bg px-1 font-condensed text-[13px] tracking-wide text-text outline-none focus:glow"
							/>
						) : (
							<span className="truncate font-condensed text-[13px] tracking-wide">{title}</span>
						)}
						{layout.desks.length > 1 ? (
							<button
								type="button"
								aria-label={`Close ${title}`}
								onClick={(event) => {
									event.stopPropagation();
									closeDesk(desk.id);
								}}
								className={`flex h-5 w-5 shrink-0 items-center justify-center text-muted hover:text-text ${active ? "" : "opacity-0 group-hover:opacity-100"}`}
							>
								<X size={11} />
							</button>
						) : null}
					</div>
				);
			})}
			<button
				type="button"
				title="New desk (Ctrl+T) — pick the project"
				aria-label="New desk"
				onClick={(event) => {
					const rect = event.currentTarget.getBoundingClientRect();
					useUi.getState().openMenu(
						rect.left,
						rect.bottom + 2,
						[
							...workspaces.map((w) => ({ label: w.name, hint: w.path, onSelect: () => newDesk(w.id) })),
							{ separator: true },
							{
								label: "Open folder…",
								onSelect: () => {
									void window.teez.workspaces.pin().then((pinned) => {
										if (pinned) newDesk(pinned.id);
									});
								},
							},
						],
					);
				}}
				className="flex w-9 shrink-0 items-center justify-center text-muted hover:text-text"
			>
				<Plus size={15} />
			</button>
		</div>
	);
}
