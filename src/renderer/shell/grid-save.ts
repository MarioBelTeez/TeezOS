/**
 * When the desk may write its grid back to the settings. A dockview that has
 * been let go of (its Desk unmounted, React StrictMode's mount → unmount →
 * mount, a re-init) reports an empty grid; saving that would wipe the
 * layout someone made. Pure, so it is tested without dockview.
 */

type Node = { readonly type?: unknown; readonly data?: unknown };

const viewsOf = (data: unknown): number => {
	const views = (data as { readonly views?: unknown } | null)?.views;
	return Array.isArray(views) ? views.length : 0;
};

function countTree(node: unknown): number {
	if (!node || typeof node !== "object") return 0;
	const { type, data } = node as Node;
	if (type === "leaf") return viewsOf(data);
	if (type === "branch" && Array.isArray(data)) return data.reduce((sum: number, child: unknown) => sum + countTree(child), 0);
	return 0;
}

/**
 * Panels actually placed in a saved dockview grid (its JSON is opaque
 * elsewhere): the views in the grid's groups, floating ones included. The
 * `panels` map is not enough — a dockview being torn down still lists its
 * panels there while its groups are already empty. Unreadable counts as none.
 */
export function gridPanelCount(grid: unknown): number {
	if (!grid || typeof grid !== "object") return 0;
	const { grid: tree, floatingGroups, popoutGroups } = grid as {
		readonly grid?: { readonly root?: unknown };
		readonly floatingGroups?: unknown;
		readonly popoutGroups?: unknown;
	};
	const extra = (groups: unknown): number =>
		Array.isArray(groups) ? groups.reduce((sum: number, group: unknown) => sum + viewsOf((group as { readonly data?: unknown } | null)?.data), 0) : 0;
	return countTree(tree?.root) + extra(floatingGroups) + extra(popoutGroups);
}

export type GridSave = {
	/** The attachment that would save has been let go of. */
	readonly disposed: boolean;
	/** Saving while the desk is being let go of (the last save of an attachment). */
	readonly detaching: boolean;
	/** The grid the dockview reports now. */
	readonly grid: unknown;
	/** The grid already saved for that desk. */
	readonly previous: unknown;
};

export function shouldSaveGrid({ disposed, detaching, grid, previous }: GridSave): boolean {
	if (disposed) return false;
	// Closing every panel is a choice made on a live desk; an empty grid on the way out is the dockview going away.
	if (detaching && gridPanelCount(grid) === 0 && gridPanelCount(previous) > 0) return false;
	return true;
}
