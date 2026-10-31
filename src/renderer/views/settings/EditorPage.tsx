import { useSettings } from "../../state/settings.ts";
import { NumberField, Row, Section, Segmented, Toggle } from "./controls.tsx";

/** The code editor: font size, wrapping, minimap and tab size; open editors follow at once. */
export function EditorPage(): React.JSX.Element | null {
	const editor = useSettings((s) => s.settings?.modules.editor);
	const setModules = useSettings((s) => s.setModules);
	if (!editor) return null;
	return (
		<Section title="Editor">
			<Row label="Font size">
				<NumberField label="Editor font size" value={editor.fontSize} min={10} max={24} step={1} unit="px" onChange={(fontSize) => setModules({ editor: { fontSize } })} />
			</Row>
			<Row label="Word wrap" hint="Long lines wrap at the edge of the editor instead of scrolling sideways.">
				<Toggle value={editor.wordWrap} label="Word wrap" onChange={(wordWrap) => setModules({ editor: { wordWrap } })} />
			</Row>
			<Row label="Minimap" hint="The outline of the file down the right-hand side.">
				<Toggle value={editor.minimap} label="Minimap" onChange={(minimap) => setModules({ editor: { minimap } })} />
			</Row>
			<Row label="Tab size" hint="For new files; a file that already uses another indent keeps it.">
				<Segmented
					value={String(editor.tabSize)}
					options={[
						{ id: "2", label: "2" },
						{ id: "4", label: "4" },
					]}
					onChange={(id) => setModules({ editor: { tabSize: id === "4" ? 4 : 2 } })}
				/>
			</Row>
		</Section>
	);
}
