import * as monaco from "monaco-editor";
// Workers as their own files, loaded on demand: inlining them made the window's
// bundle 28 MB (the TypeScript worker alone is 13 MB). Electron loads them from
// file:// without complaint; checked against the packaged build.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { DEFAULT_THEME_ID, themeById, type ThemeTokens } from "../../shared/themes.ts";
import { THEME_EVENT, currentThemeId } from "../theme.ts";

/**
 * Monaco — the editor inside VS Code — set up once for the whole window, in
 * BelTeez's colours and DM Mono.
 */

self.MonacoEnvironment = {
	getWorker(_workerId: string, label: string): Worker {
		switch (label) {
			case "json":
				return new JsonWorker();
			case "css":
			case "scss":
			case "less":
				return new CssWorker();
			case "html":
			case "handlebars":
			case "razor":
				return new HtmlWorker();
			case "typescript":
			case "javascript":
				return new TsWorker();
			default:
				return new EditorWorker();
		}
	},
};

/** (Re)defines the editor theme from the app theme; called again when the theme changes. */
export function applyEditorTheme(t: ThemeTokens): void {
	monaco.editor.defineTheme("belteez", {
		base: "vs-dark",
		inherit: true,
		rules: [
			{ token: "comment", foreground: "7d6a73", fontStyle: "italic" },
			{ token: "keyword", foreground: t.redHot.slice(1) },
			{ token: "string", foreground: "e9b8c4" },
			{ token: "number", foreground: "f5a524" },
			{ token: "regexp", foreground: "f5a524" },
			{ token: "type", foreground: t.text.slice(1), fontStyle: "bold" },
			{ token: "type.identifier", foreground: t.text.slice(1) },
			{ token: "delimiter", foreground: t.muted.slice(1) },
			{ token: "tag", foreground: t.redHot.slice(1) },
			{ token: "attribute.name", foreground: "e2c08d" },
			{ token: "attribute.value", foreground: "e9b8c4" },
			{ token: "keyword.md", foreground: t.redHot.slice(1), fontStyle: "bold" },
			{ token: "variable", foreground: t.text.slice(1) },
		],
		colors: {
			"editor.background": `${t.bg}`,
			"editor.foreground": `${t.text}`,
			"editorLineNumber.foreground": `${t.border}`,
			"editorLineNumber.activeForeground": `${t.red}`,
			"editorCursor.foreground": `${t.red}`,
			"editor.selectionBackground": `${t.red}40`,
			"editor.inactiveSelectionBackground": `${t.red}22`,
			"editor.lineHighlightBackground": `${t.surface}`,
			"editor.lineHighlightBorder": "#00000000",
			"editor.findMatchBackground": "#f5a52455",
			"editor.findMatchHighlightBackground": "#f5a52426",
			"editorIndentGuide.background1": `${t.surface2}`,
			"editorIndentGuide.activeBackground1": `${t.border}`,
			"editorWhitespace.foreground": `${t.border}`,
			"editorWidget.background": `${t.surface}`,
			"editorWidget.border": `${t.border}`,
			"editorSuggestWidget.background": `${t.surface}`,
			"editorSuggestWidget.selectedBackground": `${t.border}`,
			"editorHoverWidget.background": `${t.surface}`,
			"editorBracketMatch.background": `${t.red}22`,
			"editorBracketMatch.border": `${t.red}66`,
			"editorGutter.background": `${t.bg}`,
			"minimap.background": `${t.bg}`,
			"scrollbarSlider.background": `${t.border}88`,
			"scrollbarSlider.hoverBackground": `${t.border}aa`,
			"scrollbarSlider.activeBackground": `${t.red}66`,
			"diffEditor.insertedTextBackground": "#22c55e1f",
			"diffEditor.removedTextBackground": `${t.red}26`,
			"diffEditor.insertedLineBackground": "#22c55e12",
			"diffEditor.removedLineBackground": `${t.red}14`,
			focusBorder: `${t.red}66`,
		},
	});
	monaco.editor.setTheme("belteez");
}

// Follow the app theme: whatever is applied now, and every change after.
applyEditorTheme(themeById(currentThemeId() || DEFAULT_THEME_ID).tokens);
window.addEventListener(THEME_EVENT, () => applyEditorTheme(themeById(currentThemeId()).tokens));


// The editor has no view of the project's node_modules or tsconfig, so type
// checking would flag every import as missing. Syntax errors stay on.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
	defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

// Monaco measures glyphs when an editor is created; if DM Mono arrives later
// the cursor drifts off the characters. Re-measure once the fonts are in.
void document.fonts.ready.then(() => monaco.editor.remeasureFonts());

export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
	theme: "belteez",
	fontFamily: '"DM Mono", ui-monospace, "Cascadia Mono", monospace',
	fontSize: 13,
	lineHeight: 20,
	fontLigatures: false,
	minimap: { enabled: true, renderCharacters: false, scale: 1 },
	smoothScrolling: true,
	cursorBlinking: "smooth",
	cursorSmoothCaretAnimation: "on",
	renderLineHighlight: "all",
	scrollBeyondLastLine: false,
	automaticLayout: true,
	padding: { top: 10 },
	bracketPairColorization: { enabled: true },
	guides: { bracketPairs: "active", indentation: true },
	stickyScroll: { enabled: true },
	wordWrap: "off",
	tabSize: 2,
};

export { monaco };
