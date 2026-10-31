import { useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import type { ViewId } from "../../shared/dock.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { enabledViews, VIEW_IDS } from "../../shared/views.ts";
import { isModuleEnabled } from "../../shared/modules.ts";
import { closePanel, showView, useDesk, VIEW_PANEL } from "./dock-actions.ts";
import { VIEW_META } from "./views.ts";

/**
 * The left edge: views and settings. Views can be dragged to reorder or hidden.
 */

const VIEW_DRAG = "application/x-teez-view";

export function initials(name: string): string {
	const words = name.replace(/[-_.]+/g, " ").trim().split(/\s+|(?=[A-Z])/).filter(Boolean);
	const letters = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : name.slice(0, 2);
	return letters.toUpperCase();
}

/** `moved` placed before `target`, or after it when dropped on its lower half. */
function reorder<T>(list: readonly T[], moved: T, target: T, after: boolean): T[] {
	if (moved === target) return [...list];
	const rest = list.filter((item) => item !== moved);
	const index = rest.indexOf(target);
	if (index < 0) return [...list];
	rest.splice(after ? index + 1 : index, 0, moved);
	return rest;
}

const lowerHalf = (event: React.DragEvent): boolean => {
	const rect = event.currentTarget.getBoundingClientRect();
	return event.clientY > rect.top + rect.height / 2;
};

export function ActivityBar(): React.JSX.Element {
	const settings = useSettings((s) => s.settings);
	const view = useUi((s) => s.view);
	const setView = useUi((s) => s.setView);
	const visible = useDesk((s) => s.visible);
	const open = useDesk((s) => s.open);
	const layout = settings?.layout;
	const order = layout?.viewOrder ?? [...VIEW_IDS];
	const hidden = layout?.hiddenViews ?? [];
	const enabled = enabledViews(order, (m) => settings ? isModuleEnabled(settings.modules, m) : true);
	const [dragging, setDragging] = useState<string | null>(null);
	const [dropMark, setDropMark] = useState<{ id: string; after: boolean } | null>(null);

	const endDrag = (): void => {
		setDragging(null);
		setDropMark(null);
	};
	const dropHandlers = (type: string, id: string, onDrop: (moved: string, after: boolean) => void) => ({
		onDragOver: (event: React.DragEvent) => {
			if (!event.dataTransfer.types.includes(type)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			const after = lowerHalf(event);
			if (dropMark?.id !== id || dropMark.after !== after) setDropMark({ id, after });
		},
		onDragLeave: () => setDropMark((current) => (current?.id === id ? null : current)),
		onDrop: (event: React.DragEvent) => {
			if (!event.dataTransfer.types.includes(type)) return;
			event.preventDefault();
			const moved = event.dataTransfer.getData(type);
			if (moved) onDrop(moved, lowerHalf(event));
			endDrag();
		},
	});
	const mark = (id: string): React.JSX.Element | null =>
		dropMark?.id === id && dragging !== id ? (
			<span className={`pointer-events-none absolute left-1 right-1 h-[2px] bg-red ${dropMark.after ? "-bottom-1.5" : "-top-1.5"}`} />
		) : null;

	return (
		<nav className="glass relative flex w-14 shrink-0 flex-col items-center border-r border-border py-2">
			{/* The bar's edge carries a little of the red light down from the top. */}
			<span className="pointer-events-none absolute inset-y-0 -right-px w-px bg-linear-to-b from-red/60 via-red/10 to-transparent" />
			<div className="flex flex-col items-center gap-1">
				{enabled
					.filter((v) => !hidden.includes(v))
					.map((v) => {
						const { label, icon: Icon, key } = VIEW_META[v];
						const name = label.split(" — ")[0] ?? label;
const shown = view === "desk" && visible.includes(VIEW_PANEL[v]);
						return (
							<div
								key={v}
								className="relative"
								draggable
								onDragStart={(event) => {
									event.dataTransfer.setData(VIEW_DRAG, v);
									event.dataTransfer.effectAllowed = "move";
									setDragging(v);
								}}
								onDragEnd={endDrag}
								{...dropHandlers(VIEW_DRAG, v, (moved, after) =>
									useSettings.getState().setLayout({ viewOrder: reorder(order, moved as ViewId, v, after) }),
								)}
							>
								{mark(v)}
								<button
									type="button"
									title={`${label}  (${key})\nShows it on this desk. Drag to reorder, right-click for more`}
									aria-label={label}
									onClick={() => showView(v)}
									onContextMenu={(event) => {
										event.preventDefault();
										const items = [
											...(open.includes(VIEW_PANEL[v]) ? [{ label: `Close ${name} on this desk`, onSelect: () => closePanel(VIEW_PANEL[v]) }] : []),
...(v === "code" ? [] : [{ label: `Hide ${name} from this bar`, onSelect: () => useSettings.getState().setLayout({ hiddenViews: [...hidden, v] }) }]),
											...hidden.filter((h) => enabled.includes(h)).map((h) => ({
												label: `Show ${VIEW_META[h].label.split(" — ")[0] ?? h}`,
												onSelect: () => useSettings.getState().setLayout({ hiddenViews: hidden.filter((x) => x !== h) }),
											})),
										];
										if (items.length > 0) useUi.getState().openMenu(event.clientX, event.clientY, items);
									}}
									className={`relative flex h-10 w-10 items-center justify-center transition-colors ${
										shown ? "tab-active text-red-hot" : open.includes(VIEW_PANEL[v]) ? "text-text/80 hover:text-text" : "text-muted hover:text-text"
									} ${dragging === v ? "opacity-40" : ""}`}
								>
									{shown ? <span className="absolute -left-2 top-2 bottom-2 w-[3px] -skew-y-12 bg-red-hot shadow-[0_0_10px_var(--color-glow)]" /> : null}
									<Icon size={20} strokeWidth={1.6} className={shown ? "glow-icon" : ""} />
								</button>
							</div>
						);
					})}
			</div>

			<div className="flex-1" />

			<button
				type="button"
				title="Settings"
				aria-label="Settings"
				onClick={() => setView(view === "settings" ? "desk" : "settings")}
				className={`flex h-10 w-10 items-center justify-center transition-colors ${
					view === "settings" ? "tab-active text-red-hot" : "text-muted hover:text-text"
				}`}
			>
				<SettingsIcon size={19} strokeWidth={1.6} className={view === "settings" ? "glow-icon" : ""} />
			</button>
		</nav>
	);
}
