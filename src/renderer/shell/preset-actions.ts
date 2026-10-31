import { MAX_PRESETS, cleanPresetName, duplicatePreset, normalizePresets, presetPanelModules, type Preset } from "../../shared/presets.ts";
import type { ModulesPatch } from "../../shared/modules.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { applyPreset, presetFromCurrent } from "./dock-actions.ts";

/**
 * Saving, renaming, copying and deleting presets, shared by Settings →
 * Presets and the title bar's picker. Built-ins live in code: they can be
 * applied, reset and copied, never changed or deleted.
 */

const toast = (text: string, tone: "info" | "error" | "success" = "info"): void => useUi.getState().toast(text, tone);

function userPresets(): readonly Preset[] {
	return useSettings.getState().settings?.presets ?? [];
}

/** Writes the list when the store would keep every preset in it; says why not otherwise. */
function store(next: readonly Preset[]): boolean {
	if (normalizePresets(next).length !== next.length) {
		toast("That preset could not be saved (its layout is unreadable or too large).", "error");
		return false;
	}
	useSettings.getState().setPresets(next);
	return true;
}

function roomForOne(): boolean {
	if (userPresets().length < MAX_PRESETS) return true;
	toast(`${MAX_PRESETS} presets is the most; delete one first.`, "error");
	return false;
}

/** The open desk as a new preset; false when the name or the room is wrong. */
export function saveCurrentAsPreset(name: string): boolean {
	const clean = cleanPresetName(name);
	if (!clean) {
		toast("A preset needs a name of 1 to 40 characters.", "error");
		return false;
	}
	if (!roomForOne()) return false;
	if (!store([...userPresets(), presetFromCurrent(clean)])) return false;
	toast(`Saved “${clean}”.`, "success");
	return true;
}

export function renamePreset(id: string, name: string): boolean {
	const clean = cleanPresetName(name);
	if (!clean) {
		toast("A preset needs a name of 1 to 40 characters.", "error");
		return false;
	}
	return store(userPresets().map((p) => (p.id === id ? { ...p, name: clean } : p)));
}

export function copyPreset(source: Preset): void {
	if (!roomForOne()) return;
	const id = `p-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
	store([...userPresets(), duplicatePreset(source, id)]);
}

export function deletePreset(preset: Preset): void {
	if (preset.builtIn) return;
	if (!window.confirm(`Delete the preset “${preset.name}”?`)) return;
	store(userPresets().filter((p) => p.id !== preset.id));
}

/** A built-in as shipped: the modules its panels need turned back on, then applied. */
export function resetPreset(preset: Preset): void {
	const needed = presetPanelModules(preset);
	if (needed.length > 0) {
		const patch: Record<string, { enabled: boolean }> = {};
		for (const id of needed) patch[id] = { enabled: true };
		useSettings.getState().setModules(patch as ModulesPatch);
	}
	applyPreset(preset);
}
