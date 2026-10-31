import type { Modules } from "../../shared/modules.ts";

/**
 * Settings → Editor as Monaco options. Pure (no Monaco import), so it is
 * tested in Node; the editors apply it at creation and on every change.
 */

export type EditorModuleOptions = {
	readonly fontSize: number;
	readonly lineHeight: number;
	readonly wordWrap: "on" | "off";
	readonly minimap: { readonly enabled: boolean; readonly renderCharacters: false; readonly scale: 1 };
	readonly tabSize: number;
};

/** Lines are half again as tall as the font, as at the default 13 / 20. */
const LINE_HEIGHT_RATIO = 1.5;

export function editorOptionsFrom(editor: Modules["editor"]): EditorModuleOptions {
	return {
		fontSize: editor.fontSize,
		lineHeight: Math.round(editor.fontSize * LINE_HEIGHT_RATIO),
		wordWrap: editor.wordWrap ? "on" : "off",
		minimap: { enabled: editor.minimap, renderCharacters: false, scale: 1 },
		tabSize: editor.tabSize,
	};
}
