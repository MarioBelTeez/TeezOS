import { useUi } from "../state/ui.ts";
import { browserEnabled, openInBrowser } from "../browser/open.ts";
import { areaOf, navigate } from "./side-nav.ts";
import { safeLink, universalItems, type MenuTarget } from "./universal-menu.ts";

/**
 * A right-click anywhere without a menu of its own opens the universal menu
 * (universal-menu.ts). Panels with their own menu call preventDefault, which
 * this listener — on the window, so it runs after theirs — respects. Monaco
 * and the terminal draw their own.
 */

type TextField = HTMLInputElement | HTMLTextAreaElement;
const TEXT_INPUT = /^(text|search|url|tel|email|password|number|)$/;
const OWN_MENU = ".monaco-editor, .xterm";

function textFieldOf(element: Element): TextField | null {
	const field = element.closest("input, textarea");
	if (field instanceof HTMLTextAreaElement) return field;
	if (field instanceof HTMLInputElement && TEXT_INPUT.test(field.type)) return field;
	return null;
}

function editableHostOf(element: Element): HTMLElement | null {
	const host = element.closest("[contenteditable]");
	return host instanceof HTMLElement && host.isContentEditable ? host : null;
}

function fieldSelection(field: TextField): string {
	// Passwords are never copied out.
	if (field instanceof HTMLInputElement && field.type === "password") return "";
	// email and number fields report no selectionStart; the page selection still has it.
	if (field.selectionStart === null || field.selectionEnd === null) return window.getSelection()?.toString() ?? "";
	return field.value.slice(field.selectionStart, field.selectionEnd);
}

export function installUniversalMenu(): () => void {
	const onContextMenu = (event: MouseEvent): void => {
		if (event.defaultPrevented) return;
		const element = event.target instanceof Element ? event.target : null;
		if (!element || element.closest(OWN_MENU)) return;
		event.preventDefault();

		const field = textFieldOf(element);
		const host = field ? null : editableHostOf(element);
		const pageSelection = window.getSelection()?.toString() ?? "";
		const target: MenuTarget = {
			editable: field !== null || host !== null,
			readOnly: field ? field.readOnly || field.disabled : false,
			selection: field ? fieldSelection(field) : pageSelection,
			hasText: field ? field.value.length > 0 : (host?.textContent ?? "").length > 0,
			link: safeLink(element.closest("a[href]")?.getAttribute("href")),
		};
		const focusField = (): void => (field ?? host)?.focus();
		const area = areaOf(element);

		useUi.getState().openMenu(
			event.clientX,
			event.clientY,
			universalItems(target, {
				// execCommand edits through the field's own undo stack and fires the
				// input event React listens for, so state follows the change.
				undo: () => {
					focusField();
					document.execCommand("undo");
				},
				redo: () => {
					focusField();
					document.execCommand("redo");
				},
				// Deleted only once it is on the clipboard: a failed copy loses nothing.
				cut: () => {
					void navigator.clipboard.writeText(target.selection).then(() => {
						focusField();
						document.execCommand("delete");
					});
				},
				copy: (text) => void navigator.clipboard.writeText(text),
				paste: () => {
					focusField();
					window.teez.edit.paste();
				},
				selectAll: () => {
					focusField();
					if (field) field.select();
					else document.execCommand("selectAll");
				},
				openLink: (url) => (browserEnabled() ? openInBrowser(url) : window.open(url, "_blank")),
				// "popup" makes it a new window, which the main process sends to the system browser.
				openLinkOutside: (url) => window.open(url, "_blank", "popup"),
				back: () => navigate("back", area),
				forward: () => navigate("forward", area),
				palette: () => useUi.getState().openPalette("commands"),
				settings: () => useUi.getState().setView("settings"),
			}),
		);
	};
	window.addEventListener("contextmenu", onContextMenu);
	return () => window.removeEventListener("contextmenu", onContextMenu);
}
