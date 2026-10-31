import { createHistory, type History } from "../../shared/history.ts";
import { VIEW_IDS, type ViewId } from "../../shared/views.ts";
import { createGate, keyDirection, mouseDirection, parseNavArea, routeNav, type NavArea, type NavDirection } from "../../shared/side-nav.ts";
import { appTrail } from "../state/app-trail.ts";
import { useBrain } from "../state/brain.ts";
import { useBrowser } from "../state/browser.ts";
import { useEditor } from "../state/editor.ts";
import { activeWorkspaceIdOf, useSettings } from "../state/settings.ts";
import { showView, switchDesk } from "./dock-actions.ts";

/**
 * Back / forward from the mouse side buttons and Alt+Left / Alt+Right. The
 * panel under the pointer (or, for keys, the focused one) steps through its own
 * history; anywhere else it is the app's trail of views and desks.
 */

const AREA_ATTRIBUTE = "data-nav-area";
/** Mouse button and Windows' app-command both report one click; the second is dropped. */
const GATE_MS = 300;

const gate = createGate(GATE_MS);
const editorTrails = new Map<string, History<string>>();

export const areaOf = (element: Element | null | undefined): NavArea => parseNavArea(element?.closest(`[${AREA_ATTRIBUTE}]`)?.getAttribute(AREA_ATTRIBUTE));

/** Every file focused in an editor, per project, so Back returns to the previous one. */
function recordEditorFocus(): () => void {
	return useEditor.subscribe((state) => {
		for (const [workspaceId, tabs] of Object.entries(state.byWorkspace)) {
			if (!tabs.active) continue;
			let trail = editorTrails.get(workspaceId);
			if (!trail) {
				trail = createHistory<string>();
				editorTrails.set(workspaceId, trail);
			}
			trail.push(tabs.active);
		}
	});
}

function stepEditor(direction: NavDirection): void {
	const workspaceId = activeWorkspaceIdOf(useSettings.getState().settings);
	const trail = workspaceId ? editorTrails.get(workspaceId) : undefined;
	if (!workspaceId || !trail) return;
	const open = (path: string): boolean => !!useEditor.getState().byWorkspace[workspaceId]?.tabs.some((t) => t.path === path);
	const path = direction === "back" ? trail.back(open) : trail.forward(open);
	if (path !== undefined) useEditor.getState().activate(workspaceId, path);
}

function stepApp(direction: NavDirection): void {
	const desks = useSettings.getState().settings?.layout.desks ?? [];
	const exists = (entry: string): boolean => (entry.startsWith("desk:") ? desks.some((d) => d.id === entry.slice(5)) : (VIEW_IDS as readonly string[]).includes(entry.slice(5)));
	const entry = direction === "back" ? appTrail.back(exists) : appTrail.forward(exists);
	if (entry === undefined) return;
	if (entry.startsWith("desk:")) switchDesk(entry.slice(5), { record: false });
	else showView(entry.slice(5) as ViewId, { record: false });
}

export function navigate(direction: NavDirection, area: NavArea): void {
	if (area === "browser") {
		const activeId = useBrowser.getState().activeId;
		if (activeId) window.teez.browser.action(activeId, direction);
	} else if (area === "brain") {
		if (direction === "back") useBrain.getState().back();
		else useBrain.getState().forward();
	} else if (area === "editor") {
		stepEditor(direction);
	} else {
		stepApp(direction);
	}
}

/** Listens on the window; the returned function removes everything. */
export function installSideNav(): () => void {
	let hovered: NavArea = "app";
	const fire = (direction: NavDirection, area: NavArea): void => {
		if (gate.allow(direction, Date.now())) navigate(direction, area);
	};

	const onOver = (event: MouseEvent): void => {
		hovered = areaOf(event.target instanceof Element ? event.target : null);
	};
	// The browser's own back/forward on these buttons must not run beside ours.
	const swallow = (event: MouseEvent): void => {
		if (mouseDirection(event.button)) event.preventDefault();
	};
	const onMouseUp = (event: MouseEvent): void => {
		const direction = mouseDirection(event.button);
		if (!direction) return;
		event.preventDefault();
		fire(direction, areaOf(event.target instanceof Element ? event.target : null));
	};
	const onKey = (event: KeyboardEvent): void => {
		const direction = keyDirection(event);
		if (!direction || event.defaultPrevented) return;
		event.preventDefault();
		fire(direction, routeNav(areaOf(document.activeElement), hovered));
	};
	// Windows' app-command: the pointer is resolved here, from where it was in the window.
	const offCommand = window.teez.nav.onCommand(({ direction, x, y }) => fire(direction, areaOf(document.elementFromPoint(x, y))));
	const offEditor = recordEditorFocus();

	window.addEventListener("mouseover", onOver, true);
	window.addEventListener("mousedown", swallow, true);
	window.addEventListener("auxclick", swallow, true);
	window.addEventListener("mouseup", onMouseUp, true);
	window.addEventListener("keydown", onKey);
	return () => {
		window.removeEventListener("mouseover", onOver, true);
		window.removeEventListener("mousedown", swallow, true);
		window.removeEventListener("auxclick", swallow, true);
		window.removeEventListener("mouseup", onMouseUp, true);
		window.removeEventListener("keydown", onKey);
		offCommand();
		offEditor();
	};
}
