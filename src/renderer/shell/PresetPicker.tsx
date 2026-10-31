import { useState } from "react";
import { LayoutTemplate } from "lucide-react";
import { allPresets, MAX_PRESET_NAME } from "../../shared/presets.ts";
import { useSettings } from "../state/settings.ts";
import { useUi, type MenuItem } from "../state/ui.ts";
import { applyPreset } from "./dock-actions.ts";
import { saveCurrentAsPreset } from "./preset-actions.ts";

/**
 * Beside the desk tabs: every preset, applied to the desk in front, and
 * "Save current…", which asks for a name right here in the title bar.
 */
export function PresetPicker(): React.JSX.Element {
	const [naming, setNaming] = useState(false);
	const [name, setName] = useState("");

	const open = (event: React.MouseEvent<HTMLButtonElement>): void => {
		const rect = event.currentTarget.getBoundingClientRect();
		const presets = allPresets(useSettings.getState().settings?.presets ?? []);
		const entry = (preset: (typeof presets)[number]): MenuItem => ({ label: preset.name, onSelect: () => applyPreset(preset) });
		const builtIn = presets.filter((p) => p.builtIn);
		const yours = presets.filter((p) => !p.builtIn);
		const items: MenuItem[] = [
			{ separator: true, label: "Built-in" },
			...builtIn.map(entry),
			...(yours.length > 0 ? [{ separator: true as const, label: "Yours" }, ...yours.map(entry)] : []),
			{ separator: true },
		];
		items.push({ label: "Save current…", onSelect: () => setNaming(true) });
		items.push({ label: "Manage presets…", onSelect: () => useUi.getState().openSettings("presets") });
		useUi.getState().openMenu(rect.left, rect.bottom + 2, items, rect.top - 2);
	};

	const finish = (save: boolean): void => {
		if (save && name.trim() && !saveCurrentAsPreset(name)) return;
		setName("");
		setNaming(false);
	};

	if (naming) {
		return (
			<input
				autoFocus
				value={name}
				maxLength={MAX_PRESET_NAME}
				placeholder="Preset name, Enter to save"
				aria-label="New preset name"
				onChange={(event) => setName(event.target.value)}
				onBlur={() => finish(false)}
				onKeyDown={(event) => {
					if (event.key === "Enter") finish(true);
					if (event.key === "Escape") {
						// Handled here: Settings, if open behind, stays open (App.tsx checks defaultPrevented).
						event.preventDefault();
						finish(false);
					}
				}}
				className="no-drag my-2 w-48 shrink-0 border border-red/60 bg-black/40 px-2 font-mono text-[11px] text-text outline-none shadow-[0_0_14px_var(--color-glow)]"
			/>
		);
	}

	return (
		<button
			type="button"
			title="Presets: lay out this desk"
			aria-label="Presets"
			onClick={open}
			className="no-drag flex shrink-0 items-center gap-1.5 px-2 font-condensed text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-text"
		>
			<LayoutTemplate size={14} />
			<span>Presets</span>
		</button>
	);
}
