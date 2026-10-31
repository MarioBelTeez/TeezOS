import * as monaco from "monaco-editor";
// Workers as their own files, loaded on demand: inlining them made the window's
// bundle 28 MB (the TypeScript worker alone is 13 MB). Electron loads them from
// file:// without complaint; checked against the packaged build.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

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

monaco.editor.defineTheme("belteez", {
	base: "vs-dark",
	inherit: true,
	rules: [
		{ token: "comment", foreground: "7d6a73", fontStyle: "italic" },
		{ token: "keyword", foreground: "ff3b5c" },
		{ token: "string", foreground: "e9b8c4" },
		{ token: "number", foreground: "f5a524" },
		{ token: "regexp", foreground: "f5a524" },
		{ token: "type", foreground: "f5f0f2", fontStyle: "bold" },
		{ token: "type.identifier", foreground: "f5f0f2" },
		{ token: "delimiter", foreground: "9c8a92" },
		{ token: "tag", foreground: "ff3b5c" },
		{ token: "attribute.name", foreground: "e2c08d" },
		{ token: "attribute.value", foreground: "e9b8c4" },
		{ token: "keyword.md", foreground: "ff3b5c", fontStyle: "bold" },
		{ token: "variable", foreground: "f5f0f2" },
	],
	colors: {
		"editor.background": "#08060a",
		"editor.foreground": "#f5f0f2",
		"editorLineNumber.foreground": "#3d2e35",
		"editorLineNumber.activeForeground": "#e8002d",
		"editorCursor.foreground": "#e8002d",
		"editor.selectionBackground": "#e8002d40",
		"editor.inactiveSelectionBackground": "#e8002d22",
		"editor.lineHighlightBackground": "#110c0f",
		"editor.lineHighlightBorder": "#00000000",
		"editor.findMatchBackground": "#f5a52455",
		"editor.findMatchHighlightBackground": "#f5a52426",
		"editorIndentGuide.background1": "#1c1418",
		"editorIndentGuide.activeBackground1": "#3d2e35",
		"editorWhitespace.foreground": "#2a1f24",
		"editorWidget.background": "#110c0f",
		"editorWidget.border": "#2a1f24",
		"editorSuggestWidget.background": "#110c0f",
		"editorSuggestWidget.selectedBackground": "#2a1f24",
		"editorHoverWidget.background": "#110c0f",
		"editorBracketMatch.background": "#e8002d22",
		"editorBracketMatch.border": "#e8002d66",
		"editorGutter.background": "#08060a",
		"minimap.background": "#08060a",
		"scrollbarSlider.background": "#2a1f2488",
		"scrollbarSlider.hoverBackground": "#3d2e35aa",
		"scrollbarSlider.activeBackground": "#e8002d66",
		"diffEditor.insertedTextBackground": "#22c55e1f",
		"diffEditor.removedTextBackground": "#e8002d26",
		"diffEditor.insertedLineBackground": "#22c55e12",
		"diffEditor.removedLineBackground": "#e8002d14",
		focusBorder: "#e8002d66",
	},
});

monaco.editor.setTheme("belteez");

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
