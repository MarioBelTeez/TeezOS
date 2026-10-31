import type { MenuItem } from "../state/ui.ts";

/**
 * The right-click menu for every spot that has no menu of its own, so a
 * right-click never does nothing. What it offers comes from what is under
 * the pointer: a text field gets the editing commands, selected text gets
 * Copy, a link gets Open / Copy link; Back, Forward and the palette are
 * always there. Pure: the DOM is read and the commands run elsewhere
 * (install-universal-menu.ts).
 */

export type MenuTarget = {
	/** A text field or editable text under the pointer. */
	readonly editable: boolean;
	/** The field is read-only: copy, but no cut or paste. */
	readonly readOnly: boolean;
	/** The selected text (in the field, or on the page). */
	readonly selection: string;
	/** The field holds any text at all (for Select all). */
	readonly hasText: boolean;
	/** An http(s) link under the pointer. */
	readonly link: string | null;
};

export type MenuActions = {
	readonly undo: () => void;
	readonly redo: () => void;
	readonly cut: () => void;
	readonly copy: (text: string) => void;
	readonly paste: () => void;
	readonly selectAll: () => void;
	readonly openLink: (url: string) => void;
	readonly openLinkOutside: (url: string) => void;
	readonly back: () => void;
	readonly forward: () => void;
	readonly palette: () => void;
	readonly settings: () => void;
};

const MAX_LINK = 2048;

export function safeLink(href: string | null | undefined): string | null {
	if (!href || href.length > MAX_LINK || !/^https?:\/\//i.test(href)) return null;
	return href;
}

export function universalItems(target: MenuTarget, actions: MenuActions): MenuItem[] {
	const items: MenuItem[] = [];
	const { link, selection } = target;

	if (link) {
		items.push(
			{ label: "Open link", onSelect: () => actions.openLink(link) },
			{ label: "Open in system browser", onSelect: () => actions.openLinkOutside(link) },
			{ label: "Copy link address", onSelect: () => actions.copy(link) },
			{ separator: true },
		);
	}

	if (target.editable) {
		const canEdit = !target.readOnly;
		items.push(
			{ label: "Undo", hint: "Ctrl+Z", disabled: !canEdit, onSelect: actions.undo },
			{ label: "Redo", hint: "Ctrl+Y", disabled: !canEdit, onSelect: actions.redo },
			{ separator: true },
			{ label: "Cut", hint: "Ctrl+X", disabled: !canEdit || !selection, onSelect: actions.cut },
			{ label: "Copy", hint: "Ctrl+C", disabled: !selection, onSelect: () => actions.copy(selection) },
			{ label: "Paste", hint: "Ctrl+V", disabled: !canEdit, onSelect: actions.paste },
			{ label: "Select all", hint: "Ctrl+A", disabled: !target.hasText, onSelect: actions.selectAll },
			{ separator: true },
		);
	} else if (selection) {
		items.push({ label: "Copy", hint: "Ctrl+C", onSelect: () => actions.copy(selection) }, { separator: true });
	}

	items.push(
		{ label: "Back", hint: "Alt+←", onSelect: actions.back },
		{ label: "Forward", hint: "Alt+→", onSelect: actions.forward },
		{ separator: true },
		{ label: "Command palette", hint: "Ctrl+K", onSelect: actions.palette },
		{ label: "Settings", hint: "Ctrl+,", onSelect: actions.settings },
	);
	return items;
}
