import { isEffort } from "./effort.ts";
import { bool, clamp, isBag, pick, str } from "./normalize.ts";
import { MAX_GRID_CHARS, isPanelKind, type Placement, type PlanStep } from "./desks.ts";
import type { AgentKind } from "../main/agents/registry.ts";
import { MODULE_IDS, type ModuleId, type ModulesPatch } from "./modules.ts";
import { PANEL_MODULE } from "./views.ts";

export type PresetLayout = { readonly kind: "plan"; readonly steps: readonly PlanStep[] } | { readonly kind: "grid"; readonly grid: unknown };
export type Preset = {
	readonly id: string;           // "builtin-focus" etc. or "p-<random>"
	readonly name: string;         // 1–40 chars
	readonly builtIn: boolean;
	readonly layout: PresetLayout;
	readonly modules: Partial<Record<ModuleId, boolean>>;
	/** `effort` is absent on presets saved before 0.3.8: applying one leaves effort as it is. */
	readonly chat: { readonly agent: AgentKind; readonly model: string; readonly permission: string; readonly effort?: string } | null;
};

export const BUILT_IN_PRESETS: readonly Preset[] = [
	{
		id: "builtin-focus",
		name: "Focus chat",
		builtIn: true,
		layout: {
			kind: "plan",
			steps: [
				{ panel: "chat", placement: null, inactive: false },
				{ panel: "explorer", placement: { direction: "left" }, inactive: false, width: 220 }
			]
		},
		modules: {},
		chat: null
	},
	{
		id: "builtin-code",
		name: "Code",
		builtIn: true,
		layout: {
			kind: "plan",
			steps: [
				{ panel: "editor", placement: null, inactive: false },
				{ panel: "explorer", placement: { direction: "left" }, inactive: false, width: 260 },
				{ panel: "chat", placement: { direction: "right" }, inactive: false, width: 460 },
				{ panel: "terminal", placement: { direction: "below" }, inactive: false, height: 240 }
			]
		},
		modules: {},
		chat: null
	},
	{
		id: "builtin-vault",
		name: "Vault",
		builtIn: true,
		layout: {
			kind: "plan",
			steps: [
				{ panel: "brain", placement: null, inactive: false },
				{ panel: "chat", placement: { direction: "right" }, inactive: false, width: 480 }
			]
		},
		modules: {},
		chat: null
	},
	{
		id: "builtin-ops",
		name: "Ops",
		builtIn: true,
		layout: {
			kind: "plan",
			steps: [
				{ panel: "server", placement: null, inactive: false },
				{ panel: "automations", placement: { direction: "within", reference: "server" }, inactive: true },
				{ panel: "agents", placement: { direction: "within", reference: "server" }, inactive: true },
				{ panel: "terminal", placement: { direction: "below" }, inactive: false, height: 260 }
			]
		},
		modules: {},
		chat: null
	}
];

export const MAX_PRESETS = 30;

const PRESET_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_PLAN_STEPS = 20;
const DIRECTIONS = ["within", "left", "right", "above", "below"] as const;

/** `undefined` means malformed (drop the step); `null` is the root step's "no placement". */
function normalizePlacement(value: unknown): Placement | null | undefined {
	if (value === null) return null;
	if (!isBag(value)) return undefined;
	const direction = pick(value["direction"], DIRECTIONS, "within");
	if (value["direction"] !== direction) return undefined;
	const reference = value["reference"];
	if (direction === "within") return isPanelKind(reference) ? { direction, reference } : undefined;
	return isPanelKind(reference) ? { direction, reference } : { direction };
}

function normalizeStep(value: unknown): PlanStep | null {
	if (!isBag(value) || !isPanelKind(value["panel"])) return null;
	const placement = normalizePlacement(value["placement"]);
	if (placement === undefined) return null;
	const width = clamp(value["width"], 80, 4000, 0);
	const height = clamp(value["height"], 80, 4000, 0);
	return {
		panel: value["panel"],
		placement,
		inactive: bool(value["inactive"], false),
		...(width > 0 ? { width } : {}),
		...(height > 0 ? { height } : {}),
	};
}

function normalizeLayout(value: unknown): PresetLayout | null {
	if (!isBag(value)) return null;
	if (value["kind"] === "plan" && Array.isArray(value["steps"])) {
		const steps = value["steps"].slice(0, MAX_PLAN_STEPS).map(normalizeStep);
		if (steps.length === 0 || steps.includes(null)) return null;
		return { kind: "plan", steps: steps as PlanStep[] };
	}
	if (value["kind"] === "grid" && isBag(value["grid"])) {
		try {
			return JSON.stringify(value["grid"]).length <= MAX_GRID_CHARS ? { kind: "grid", grid: value["grid"] } : null;
		} catch {
			return null;
		}
	}
	return null;
}

function normalizePresetModules(value: unknown): Partial<Record<ModuleId, boolean>> {
	const out: Partial<Record<ModuleId, boolean>> = {};
	if (!isBag(value)) return out;
	for (const id of MODULE_IDS) {
		const flag = value[id];
		if (typeof flag === "boolean") out[id] = flag;
	}
	return out;
}

function normalizePresetChat(value: unknown): Preset["chat"] {
	if (!isBag(value)) return null;
	const agent = pick<AgentKind>(value["agent"], ["claude", "agy", "codex"], "claude");
	const model = str(value["model"]);
	const permission = str(value["permission"]);
	if (value["agent"] !== agent || model === null || permission === null) return null;
	const effort = isEffort(agent, value["effort"]) ? { effort: value["effort"] } : {};
	return { agent, model: model.slice(0, 80), permission: permission.slice(0, 40), ...effort };
}

/** User presets only: built-ins live in code, so a stored one (or one claiming to be) is ignored. */
export function normalizePresets(raw: unknown): Preset[] {
	if (!Array.isArray(raw)) return [];
	const result: Preset[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (result.length >= MAX_PRESETS) break;
		if (!isBag(item) || item["builtIn"] !== false) continue;
		const id = str(item["id"]);
		if (!id || !PRESET_ID.test(id) || seen.has(id) || id.startsWith("builtin-")) continue;
		const name = str(item["name"])?.trim() ?? "";
		if (!name || name.length > 40) continue;
		const layout = normalizeLayout(item["layout"]);
		if (!layout) continue;
		seen.add(id);
		result.push({ id, name, builtIn: false, layout, modules: normalizePresetModules(item["modules"]), chat: normalizePresetChat(item["chat"]) });
	}
	return result;
}

export function allPresets(user: readonly Preset[]): Preset[] {
	return [...BUILT_IN_PRESETS, ...user];
}

export const MAX_PRESET_NAME = 40;

/** A name as typed, trimmed; null when it is empty or too long. */
export function cleanPresetName(name: string): string | null {
	const trimmed = name.trim();
	return trimmed.length > 0 && trimmed.length <= MAX_PRESET_NAME ? trimmed : null;
}

export type PresetState = {
	readonly id: string;
	readonly name: string;
	/** dockview's JSON of the open desk. */
	readonly grid: unknown;
	readonly enabled: Partial<Record<ModuleId, boolean>>;
	readonly chat: Preset["chat"];
};

/** The pure core of saving the current desk as a preset. */
export function presetFromState(state: PresetState): Preset {
	return {
		id: state.id,
		name: state.name.trim().slice(0, MAX_PRESET_NAME),
		builtIn: false,
		layout: { kind: "grid", grid: state.grid },
		modules: { ...state.enabled },
		chat: state.chat ? { ...state.chat } : null,
	};
}

/** A user copy of any preset (built-ins too: the way to change one). */
export function duplicatePreset(source: Preset, id: string): Preset {
	const suffix = " copy";
	return { ...source, id, name: `${source.name.slice(0, MAX_PRESET_NAME - suffix.length)}${suffix}`, builtIn: false };
}

/** A preset's module flags as a settings patch. Chat and the editor cannot be turned off. */
export function presetModulesPatch(flags: Preset["modules"]): ModulesPatch {
	const patch: Record<string, { enabled: boolean }> = {};
	for (const id of MODULE_IDS) {
		const flag = flags[id];
		if (id === "chat" || id === "editor" || typeof flag !== "boolean") continue;
		patch[id] = { enabled: flag };
	}
	return patch as ModulesPatch;
}

/** The modules a plan preset's panels belong to (a grid is opaque: nothing). */
export function presetPanelModules(preset: Preset): ModuleId[] {
	if (preset.layout.kind !== "plan") return [];
	const used = new Set<ModuleId>();
	for (const step of preset.layout.steps) {
		const module = PANEL_MODULE[step.panel];
		if (module !== "chat" && module !== "editor") used.add(module);
	}
	return [...used];
}
