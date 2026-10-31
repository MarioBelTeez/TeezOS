import { ArrowDown, ArrowUp, FolderOpen, X } from "lucide-react";
import type { Workspace } from "../../../main/settings/store.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { useWorkspaceIcons } from "../../state/icons.ts";
import { initials } from "../../shell/ActivityBar.tsx";
import { closeDesksOf, openWorkspace } from "../../shell/dock-actions.ts";
import { Button, Section } from "./controls.tsx";

/**
 * The pinned folders (projects): their order, their icon, and unpinning —
 * which first closes the project's desks, so no desk points at a folder
 * TeezAI no longer knows.
 */

async function changeIcon(workspace: Workspace): Promise<void> {
	const result = await window.teez.workspaces.pickIcon(workspace.id);
	if (!result.ok && result.reason !== "cancelled") useUi.getState().toast(result.reason, "error");
	void useWorkspaceIcons.getState().refresh(workspace.id);
}

async function setIconMode(workspace: Workspace, mode: "logo" | "initials"): Promise<void> {
	await window.teez.workspaces.iconMode(workspace.id, mode);
	void useWorkspaceIcons.getState().refresh(workspace.id);
}

function unpin(workspace: Workspace): void {
	const desks = useSettings.getState().settings?.layout.desks.filter((d) => d.workspaceId === workspace.id).length ?? 0;
	const closing = desks > 0 ? ` Its ${desks === 1 ? "desk closes" : `${desks} desks close`}.` : "";
	if (!window.confirm(`Unpin ${workspace.name}? The folder itself is not touched.${closing}`)) return;
	closeDesksOf(workspace.id);
	void window.teez.workspaces.unpin(workspace.id);
}

const iconButton = "text-muted hover:text-text";

export function ProjectsPage(): React.JSX.Element | null {
	const workspaces = useSettings((s) => s.settings?.workspaces);
	const icons = useWorkspaceIcons((s) => s.byId);
	if (!workspaces) return null;

	const move = (index: number, by: number): void => {
		const ids = workspaces.map((w) => w.id);
		const [id] = ids.splice(index, 1);
		if (!id) return;
		ids.splice(Math.max(0, Math.min(ids.length, index + by)), 0, id);
		void window.teez.workspaces.reorder(ids);
	};

	return (
		<Section title="Pinned projects">
			<p className="mb-2 max-w-3xl font-mono text-[10.5px] text-muted">The desk tabs' + opens these. The order here is the order there.</p>
			<ul className="max-w-3xl divide-y divide-border border border-border">
				{workspaces.map((workspace, index) => {
					const icon = icons[workspace.id] ?? null;
					return (
						<li key={workspace.id} className="flex items-center gap-3 px-3 py-2">
							<span className="flex h-8 w-8 shrink-0 items-center justify-center cut-corner bg-bg font-display text-[15px] tracking-wider text-muted ring-1 ring-border">
								{icon ? <img src={icon} alt="" className="h-5 w-5 object-contain" /> : initials(workspace.name)}
							</span>
							<button type="button" title="Open its desk" onClick={() => openWorkspace(workspace.id)} className="min-w-0 flex-1 text-left">
								<p className="text-[14px] hover:text-red-hot">{workspace.name}</p>
								<p className="truncate font-mono text-[10.5px] text-muted">{workspace.path}</p>
							</button>
							<Button onClick={() => void changeIcon(workspace)}>Change icon…</Button>
							{workspace.icon === "initials" ? (
								<Button onClick={() => void setIconMode(workspace, "logo")}>Use its logo</Button>
							) : (
								<Button onClick={() => void setIconMode(workspace, "initials")}>Use initials</Button>
							)}
							<button type="button" title="Move up" aria-label={`Move ${workspace.name} up`} onClick={() => move(index, -1)} className={iconButton}>
								<ArrowUp size={14} />
							</button>
							<button type="button" title="Move down" aria-label={`Move ${workspace.name} down`} onClick={() => move(index, 1)} className={iconButton}>
								<ArrowDown size={14} />
							</button>
							<button type="button" title="Open in File Explorer" aria-label={`Open ${workspace.name} in File Explorer`} onClick={() => void window.teez.workspaces.reveal(workspace.id, "")} className={iconButton}>
								<FolderOpen size={14} />
							</button>
							<button type="button" title="Unpin" aria-label={`Unpin ${workspace.name}`} onClick={() => unpin(workspace)} className="text-muted hover:text-red">
								<X size={14} />
							</button>
						</li>
					);
				})}
			</ul>
			<div className="mt-3">
				<Button onClick={() => void window.teez.workspaces.pin()}>Pin a folder</Button>
			</div>
		</Section>
	);
}
