import { useRef, useState } from "react";
import { allPresets, MAX_PRESET_NAME, type Preset } from "../../../shared/presets.ts";
import { enabledViews, VIEW_IDS } from "../../../shared/views.ts";
import { isModuleEnabled } from "../../../shared/modules.ts";
import { useSettings } from "../../state/settings.ts";
import { VIEW_META } from "../../shell/views.ts";
import { applyPreset, PANEL_LABEL, resetLayout } from "../../shell/dock-actions.ts";
import { copyPreset, deletePreset, renamePreset, resetPreset, saveCurrentAsPreset } from "../../shell/preset-actions.ts";
import { Button, Row, Section, Segmented } from "./controls.tsx";

const inputClass = "min-w-0 bg-surface px-2 py-1 font-mono text-[12px] text-text outline-none ring-1 ring-border focus:glow";

function describe(preset: Preset): string {
	if (preset.layout.kind === "plan") return preset.layout.steps.map((s) => PANEL_LABEL[s.panel]).join(" · ");
	const off = Object.entries(preset.modules).filter(([, on]) => on === false).length;
	return `saved desk${off > 0 ? ` · ${off} module${off === 1 ? "" : "s"} off` : ""}${preset.chat ? ` · ${preset.chat.agent === "claude" ? "Claude" : "Antigravity"} chats` : ""}`;
}

function PresetRow({ preset }: { readonly preset: Preset }): React.JSX.Element {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(preset.name);
	/** Enter or Escape ends the edit; the blur that follows as the field goes away must not end it again. */
	const ended = useRef(false);
	const start = (): void => {
		ended.current = false;
		setName(preset.name);
		setEditing(true);
	};
	const finish = (save: boolean): void => {
		if (ended.current) return;
		if (save && name.trim() !== preset.name && !renamePreset(preset.id, name)) return;
		ended.current = true;
		setEditing(false);
	};
	return (
		<li className="flex items-center gap-3 px-3 py-2">
			<div className="min-w-0 flex-1">
				{editing ? (
					<input
						autoFocus
						value={name}
						maxLength={MAX_PRESET_NAME}
						aria-label="Preset name"
						onChange={(event) => setName(event.target.value)}
						onBlur={() => finish(true)}
						onKeyDown={(event) => {
							if (event.key === "Enter") finish(true);
							if (event.key === "Escape") {
								event.preventDefault();
								finish(false);
							}
						}}
						className={`${inputClass} w-64`}
					/>
				) : (
					<p className="flex items-center gap-2 text-[14px]">
						{preset.name}
						{preset.builtIn ? <span className="bg-surface-2 px-1.5 font-condensed text-[10px] uppercase tracking-wider text-muted ring-1 ring-border">built-in</span> : null}
					</p>
				)}
				<p className="truncate font-mono text-[10.5px] text-muted">{describe(preset)}</p>
			</div>
			<Button tone="hot" onClick={() => applyPreset(preset)}>
				Apply
			</Button>
			{preset.builtIn ? (
				<Button title="Turns back on the modules its panels need, then applies it as shipped" onClick={() => resetPreset(preset)}>
					Reset
				</Button>
			) : (
				<Button onClick={start}>Rename</Button>
			)}
			<Button onClick={() => copyPreset(preset)}>Duplicate</Button>
			{preset.builtIn ? null : (
				<Button tone="danger" onClick={() => deletePreset(preset)}>
					Delete
				</Button>
			)}
		</li>
	);
}

/** Presets (whole-desk layouts with their modules and chat defaults) and the open desk's layout. */
export function PresetsPage(): React.JSX.Element | null {
	const settings = useSettings((s) => s.settings);
	const setLayout = useSettings((s) => s.setLayout);
	const [name, setName] = useState("");
	if (!settings) return null;
	const presets = allPresets(settings.presets);
	const barViews = enabledViews([...VIEW_IDS], (m) => isModuleEnabled(settings.modules, m)).filter((v) => v !== "code");
	const hidden = settings.layout.hiddenViews;

	const save = (): void => {
		if (saveCurrentAsPreset(name)) setName("");
	};

	return (
		<>
			<Section title="Presets">
				<p className="mb-2 max-w-3xl font-mono text-[10.5px] text-muted">Applying a preset changes the desk in front only. Built-ins cannot be changed: duplicate one to make it yours.</p>
				<ul className="max-w-3xl divide-y divide-border border border-border">
					{presets.map((preset) => (
						<PresetRow key={preset.id} preset={preset} />
					))}
				</ul>
				<div className="mt-3 flex max-w-3xl gap-1">
					<input
						value={name}
						maxLength={MAX_PRESET_NAME}
						placeholder="Name for this desk's layout"
						aria-label="New preset name"
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && name.trim()) save();
						}}
						className={`${inputClass} flex-1`}
					/>
					<Button disabled={!name.trim()} onClick={save}>
						Save current layout as preset
					</Button>
				</div>
			</Section>

			<Section title="Layout">
				<Row label="Views in the left bar" hint="Drag them in the bar to reorder; Code always stays. Turned-off modules are not listed.">
					<div className="flex flex-wrap gap-4 font-mono text-[11.5px]">
						{barViews.map((v) => (
							<label key={v} className="flex items-center gap-1.5">
								<input
									type="checkbox"
									checked={!hidden.includes(v)}
									onChange={(event) => setLayout({ hiddenViews: event.target.checked ? hidden.filter((h) => h !== v) : [...hidden, v] })}
									className="accent-[#e8002d]"
								/>
								{VIEW_META[v].label.split(" — ")[0] ?? VIEW_META[v].label}
							</label>
						))}
					</div>
				</Row>
				<Row label="Panels" hint="Drag a tab anywhere on the desk: onto other tabs to stack, onto an edge to split. Right-click a tab to float or maximize it.">
					<Button onClick={resetLayout}>Reset this desk's layout</Button>
				</Row>
				<Row label="Lock the layout" hint="Panels stay where they are: tabs and groups cannot be dragged.">
					<Segmented
						value={settings.layout.locked ? "on" : "off"}
						options={[
							{ id: "on", label: "Locked" },
							{ id: "off", label: "Free" },
						]}
						onChange={(id) => setLayout({ locked: id === "on" })}
					/>
				</Row>
			</Section>
		</>
	);
}
