import { describe, expect, test } from "vitest";
import { BUILT_IN_PRESETS, MAX_PRESETS, allPresets, cleanPresetName, duplicatePreset, normalizePresets, presetFromState, presetModulesPatch, presetPanelModules } from "./presets.ts";

describe("presets", () => {
	test("four built-ins with plan layouts", () => {
		expect(BUILT_IN_PRESETS.map((p) => p.name)).toEqual(["Focus chat", "Code", "Vault", "Ops"]);
		expect(BUILT_IN_PRESETS.every((p) => p.builtIn && p.layout.kind === "plan")).toBe(true);
	});
	test("built-ins are never read back from the file", () => {
		const raw = [{ ...BUILT_IN_PRESETS[0], name: "Hacked" }];
		expect(normalizePresets(raw)).toEqual([]);
	});
	test("a user preset survives; broken ones are dropped", () => {
		const good = { id: "p-1", name: "Mine", builtIn: false, layout: { kind: "grid", grid: { a: 1 } }, modules: { brain: false, nope: true }, chat: { agent: "claude", model: "opus", permission: "auto" } };
		const out = normalizePresets([good, { id: 3 }, { id: "p-2", name: "", layout: { kind: "grid", grid: {} } }]);
		expect(out).toHaveLength(1);
		expect(out[0]?.modules).toEqual({ brain: false });
	});
	test("a preset's chat keeps a valid effort and drops one the agent does not have", () => {
		const preset = (chat: Record<string, unknown>) => ({ id: "p-1", name: "Mine", builtIn: false, layout: { kind: "grid", grid: {} }, modules: {}, chat });
		expect(normalizePresets([preset({ agent: "claude", model: "opus", permission: "auto", effort: "max" })])[0]?.chat).toEqual({ agent: "claude", model: "opus", permission: "auto", effort: "max" });
		expect(normalizePresets([preset({ agent: "agy", model: "", permission: "plan", effort: "max" })])[0]?.chat).toEqual({ agent: "agy", model: "", permission: "plan" });
		// Saved before 0.3.8: no effort at all, still a valid preset.
		expect(normalizePresets([preset({ agent: "claude", model: "opus", permission: "auto" })])[0]?.chat).toEqual({ agent: "claude", model: "opus", permission: "auto" });
	});
	test("a Codex preset's chat survives a reload as Codex", () => {
		const preset = (chat: Record<string, unknown>) => ({ id: "p-1", name: "Mine", builtIn: false, layout: { kind: "grid", grid: {} }, modules: {}, chat });
		expect(normalizePresets([preset({ agent: "codex", model: "gpt-5.5", permission: "auto-edit", effort: "high" })])[0]?.chat).toEqual({
			agent: "codex",
			model: "gpt-5.5",
			permission: "auto-edit",
			effort: "high",
		});
	});
	test("at most 30, and allPresets puts built-ins first", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ id: `p-${i}`, name: `P${i}`, builtIn: false, layout: { kind: "grid", grid: {} }, modules: {}, chat: null }));
		expect(normalizePresets(many)).toHaveLength(MAX_PRESETS);
		expect(allPresets(normalizePresets(many))[0]?.builtIn).toBe(true);
	});

	test("plan layouts are validated step by step", () => {
		const base = { id: "p-1", name: "Mine", builtIn: false, modules: {}, chat: null };
		const ok = normalizePresets([{ ...base, layout: { kind: "plan", steps: [{ panel: "chat", placement: null, inactive: false }, { panel: "explorer", placement: { direction: "left" }, inactive: false, width: 220 }] } }]);
		expect(ok).toHaveLength(1);
		const bad = normalizePresets([{ ...base, layout: { kind: "plan", steps: [{ panel: "nope", placement: null, inactive: false }] } }]);
		expect(bad).toEqual([]);
	});
	test("duplicate, malformed, or builtin-prefixed ids are dropped", () => {
		const mk = (id: unknown) => ({ id, name: "A", builtIn: false, layout: { kind: "grid", grid: {} }, modules: {}, chat: null });
		expect(normalizePresets([mk("p-1"), mk("p-1"), mk("bad id!"), mk("builtin-foo")])).toHaveLength(1);
	});
});

test("presetFromState captures grid, enabled modules and chat defaults", () => {
	const p = presetFromState({ id: "p-abc", name: "Night", grid: { g: 1 }, enabled: { brain: false, feed: true }, chat: { agent: "claude", model: "sonnet", permission: "auto" } });
	expect(p).toEqual({ id: "p-abc", name: "Night", builtIn: false, layout: { kind: "grid", grid: { g: 1 } }, modules: { brain: false, feed: true }, chat: { agent: "claude", model: "sonnet", permission: "auto" } });
});

test("presetFromState output survives normalizePresets", () => {
	const p = presetFromState({ id: "p-abcd1234", name: "  Night  ", grid: { g: 1 }, enabled: { brain: false }, chat: null });
	expect(p.name).toBe("Night");
	expect(normalizePresets([p])).toEqual([p]);
});

describe("preset names", () => {
	test("trimmed, 1 to 40 characters", () => {
		expect(cleanPresetName("  Deep work ")).toBe("Deep work");
		expect(cleanPresetName("   ")).toBeNull();
		expect(cleanPresetName("x".repeat(41))).toBeNull();
		expect(cleanPresetName("x".repeat(40))).toBe("x".repeat(40));
	});
});

describe("duplicatePreset", () => {
	test("a user copy with a new id and a copy name, built-ins included", () => {
		const code = BUILT_IN_PRESETS[1];
		if (!code) throw new Error("no Code preset");
		const copy = duplicatePreset(code, "p-12345678");
		expect(copy).toEqual({ ...code, id: "p-12345678", name: "Code copy", builtIn: false });
		expect(normalizePresets([copy])).toHaveLength(1);
	});
	test("a long name stays within 40 characters", () => {
		const long = presetFromState({ id: "p-1", name: "y".repeat(40), grid: {}, enabled: {}, chat: null });
		expect(duplicatePreset(long, "p-2").name.length).toBe(40);
	});
});

describe("presetModulesPatch", () => {
	test("turns flags into a modules patch; chat and editor are always on", () => {
		expect(presetModulesPatch({ brain: false, feed: true, chat: false, editor: false })).toEqual({ brain: { enabled: false }, feed: { enabled: true } });
		expect(presetModulesPatch({})).toEqual({});
	});
});

describe("presetPanelModules", () => {
	test("the modules a plan preset's panels need", () => {
		const ops = BUILT_IN_PRESETS.find((p) => p.id === "builtin-ops");
		if (!ops) throw new Error("no Ops preset");
		expect(presetPanelModules(ops).sort()).toEqual(["agents", "automations", "server", "terminal"]);
	});
	test("a grid preset needs nothing it does not say", () => {
		const grid = presetFromState({ id: "p-1", name: "G", grid: {}, enabled: {}, chat: null });
		expect(presetPanelModules(grid)).toEqual([]);
	});
});
