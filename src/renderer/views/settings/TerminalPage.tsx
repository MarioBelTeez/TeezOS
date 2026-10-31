import { useEffect, useState } from "react";
import { useSettings } from "../../state/settings.ts";
import { EnabledRow, NumberField, Row, Section, Select, Toggle } from "./controls.tsx";

/** The terminal: shell for new tabs, font size, cursor blink. Size and blink apply to open tabs at once. */
export function TerminalPage(): React.JSX.Element | null {
	const terminal = useSettings((s) => s.settings?.modules.terminal);
	const setModules = useSettings((s) => s.setModules);
	const [shells, setShells] = useState<{ readonly auto: string; readonly gitBash: boolean } | null>(null);

	useEffect(() => {
		void window.teez.terminal.shells().then(setShells, () => setShells(null));
	}, []);

	if (!terminal) return null;
	const gitBashMissing = shells !== null && !shells.gitBash;
	return (
		<Section title="Terminal">
			<EnabledRow module="terminal" what="the terminal" />
			<Row
				label="Shell"
				hint={
					terminal.shell === "gitbash" && gitBashMissing
						? String.raw`Git Bash was not found in C:\Program Files\Git; new tabs use the automatic shell.`
						: "For new terminal tabs; open ones keep their shell."
				}
			>
				<Select
					label="Shell"
					value={terminal.shell}
					options={[
						{ id: "auto", label: `Automatic${shells ? ` (${shells.auto})` : ""}` },
						{ id: "powershell", label: "Windows PowerShell" },
						{ id: "gitbash", label: gitBashMissing ? "Git Bash (not found)" : "Git Bash" },
						{ id: "cmd", label: "Command Prompt (cmd)" },
					]}
					onChange={(id) => setModules({ terminal: { shell: id === "powershell" || id === "gitbash" || id === "cmd" ? id : "auto" } })}
				/>
			</Row>
			<Row label="Font size">
				<NumberField label="Terminal font size" value={terminal.fontSize} min={9} max={24} step={0.5} unit="px" onChange={(fontSize) => setModules({ terminal: { fontSize } })} />
			</Row>
			<Row label="Cursor blink">
				<Toggle value={terminal.cursorBlink} label="Cursor blink" onChange={(cursorBlink) => setModules({ terminal: { cursorBlink } })} />
			</Row>
		</Section>
	);
}
