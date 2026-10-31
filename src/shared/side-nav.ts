/** Pure decisions behind the mouse side buttons and Alt+Left / Alt+Right. */

export type NavDirection = "back" | "forward";
export type NavArea = "browser" | "brain" | "editor" | "app";

/** XButton1 / XButton2 as `MouseEvent.button` reports them. */
export function mouseDirection(button: number): NavDirection | null {
	if (button === 3) return "back";
	if (button === 4) return "forward";
	return null;
}

export function keyDirection(event: { readonly key: string; readonly altKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean }): NavDirection | null {
	if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
	if (event.key === "ArrowLeft") return "back";
	if (event.key === "ArrowRight") return "forward";
	return null;
}

/** The `data-nav-area` a panel carries; anything else counts as the app as a whole. */
export function parseNavArea(value: string | null | undefined): NavArea {
	return value === "browser" || value === "brain" || value === "editor" ? value : "app";
}

/** The panel under the pointer decides; with none, the focused panel; with none, the app. */
export function routeNav(pointer: NavArea, focus: NavArea): NavArea {
	return pointer !== "app" ? pointer : focus;
}

/** Drops a repeat of the same direction within `ms`: the mouse event and Windows' app-command both arrive for one click. */
export function createGate(ms: number): { readonly allow: (direction: NavDirection, now: number) => boolean } {
	const last: Record<NavDirection, number> = { back: -Infinity, forward: -Infinity };
	return {
		allow: (direction, now) => {
			if (now - last[direction] < ms) return false;
			last[direction] = now;
			return true;
		},
	};
}
