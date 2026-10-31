import { expect, test } from "vitest";
import { DEFAULT_MODULES } from "../../shared/modules.ts";
import { editorOptionsFrom } from "./editor-options.ts";

test("the editor module's options as Monaco options", () => {
	expect(editorOptionsFrom(DEFAULT_MODULES.editor)).toEqual({
		fontSize: 13,
		lineHeight: 20,
		wordWrap: "off",
		minimap: { enabled: true, renderCharacters: false, scale: 1 },
		tabSize: 2,
	});
	expect(editorOptionsFrom({ enabled: true, fontSize: 18, wordWrap: true, minimap: false, tabSize: 4 })).toEqual({
		fontSize: 18,
		lineHeight: 27,
		wordWrap: "on",
		minimap: { enabled: false, renderCharacters: false, scale: 1 },
		tabSize: 4,
	});
});
