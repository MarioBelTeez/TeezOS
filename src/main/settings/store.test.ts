import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS,
	SettingsStore,
	firstRunWorkspaces,
	normalizeSettings,
	workspaceId,
} from "./store.ts";
import { isModuleEnabled, mergeModules } from "../../shared/modules.ts";
import { enabledViews } from "../../shared/views.ts";

describe("normalizeSettings", () => {
	test("garbage becomes the defaults", () => {
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ agent: { notify: false } }).agent.notify).toBe(false);
		const icons = normalizeSettings({
			workspaces: [
				{ id: "a", name: "A", path: "C:/a", icon: "initials" },
				{ id: "b", name: "B", path: "C:/b", icon: "<svg>" },
			],
		}).workspaces;
		expect(icons.map((w) => w.icon)).toEqual(["initials", undefined]);
		expect(normalizeSettings({ agent: { notify: "yes" } }).agent.notify).toBe(true);
		expect(normalizeSettings({ agent: { presence: "private" } }).agent.presence).toBe("private");
		expect(normalizeSettings({ agent: { presence: "loud" } }).agent.presence).toBe("on");
	});

	test("keeps valid workspaces and drops broken ones", () => {
		const settings = normalizeSettings({
			workspaces: [
				{ id: "a", name: "Vault", path: "C:\\v" },
				{ id: 3, name: "bad" },
				{ id: "b", name: "", path: "C:\\b" },
			],
			activeWorkspaceId: "a",
		});
		expect(settings.workspaces).toEqual([
			{ id: "a", name: "Vault", path: "C:\\v" },
			{ id: "b", name: "b", path: "C:\\b" },
		]);
		expect(settings.activeWorkspaceId).toBe("a");
	});

	test("an active id that names no workspace falls back to the first", () => {
		const settings = normalizeSettings({
			workspaces: [{ id: "a", name: "A", path: "C:\\a" }],
			activeWorkspaceId: "gone",
		});
		expect(settings.activeWorkspaceId).toBe("a");
	});

	test("layout from before the dock carries over: side panel → left, chat → right, terminal → bottom", () => {
		const layout = normalizeSettings({ layout: { sidePanelWidth: 300, chatWidth: 520, terminalHeight: 333, sidePanelOpen: false, terminalOpen: true } }).layout;
		expect(layout).toMatchObject({ leftWidth: 300, rightWidth: 520, bottomHeight: 333, leftOpen: false, rightOpen: true, bottomOpen: true });
		expect(layout.dock).toEqual({ left: ["explorer", "search", "git", "sessions"], right: ["chat"], bottom: ["terminal"] });
	});

	test("clamps layout numbers into a usable range", () => {
		const settings = normalizeSettings({ layout: { leftWidth: 5, rightWidth: 99999 } });
		expect(settings.layout.leftWidth).toBeGreaterThanOrEqual(160);
		expect(settings.layout.rightWidth).toBeLessThanOrEqual(1200);
	});

	test("desks follow the pinned folders: an unpinned project's desk closes, the next one takes over", () => {
		const settings = normalizeSettings({
			workspaces: [{ id: "a1", name: "A", path: "C:\A" }],
			activeWorkspaceId: "a1",
			layout: {
				desks: [
					{ id: "x", name: "", workspaceId: "a1", grid: { grid: {} } },
					{ id: "y", name: "Old", workspaceId: "gone", grid: null },
				],
				activeDeskId: "y",
				locked: true,
			},
		});
		expect(settings.layout.desks).toEqual([{ id: "x", name: "", workspaceId: "a1", grid: { grid: {} } }]);
		expect(settings.layout.activeDeskId).toBe("x");
		expect(settings.layout.locked).toBe(true);
	});

	test("unknown agent values fall back", () => {
		const settings = normalizeSettings({ agent: { defaultAgent: "gpt", agyPermission: "yolo" } });
		expect(settings.agent.defaultAgent).toBe("claude");
		expect(settings.agent.agyPermission).toBe("accept-edits");
	});

	test("auto is a Claude permission mode that survives a reload", () => {
		const settings = normalizeSettings({ agent: { claudePermission: "auto" } });
		expect(settings.agent.claudePermission).toBe("auto");
	});

	test("0.3.0 fields: modules, presets, new defaults", () => {
		const s = normalizeSettings({ layout: { hiddenViews: ["server"] } });
		expect(s.modules.server.enabled).toBe(false);
		expect(s.presets).toEqual([]);
		expect(normalizeSettings({}).agent.claudePermission).toBe("auto");
		expect(normalizeSettings({ agent: { claudePermission: "default" } }).agent.claudePermission).toBe("default");
	});

	test("a view hidden in 0.2.6 becomes a disabled module, and comes back to the bar when the module is turned on", () => {
		const old = normalizeSettings({ layout: { hiddenViews: ["server", "brain"], viewOrder: ["code", "server", "brain", "feed"] } });
		expect(old.modules.server.enabled).toBe(false);
		expect(old.modules.brain.enabled).toBe(false);
		// Converted, so no longer hidden as well: the module switch alone decides.
		expect(old.layout.hiddenViews).toEqual([]);
		const on = mergeModules(old.modules, { server: { enabled: true } });
		const bar = enabledViews(old.layout.viewOrder, (m) => isModuleEnabled(on, m)).filter((v) => !old.layout.hiddenViews.includes(v));
		expect(bar).toContain("server");
		expect(bar).not.toContain("brain");
		// A 0.3.0 file keeps its own hidden views: modules is there, so nothing is converted.
		const current = normalizeSettings({ layout: { hiddenViews: ["server"] }, modules: { server: { enabled: true } } });
		expect(current.layout.hiddenViews).toEqual(["server"]);
		expect(current.modules.server.enabled).toBe(true);
	});

	test("normalizing a full 0.3.0 settings file twice changes nothing more", () => {
		const full = normalizeSettings({
			workspaces: [{ id: "a", name: "A", path: "C:\\A" }],
			layout: { hiddenViews: ["automations"], viewOrder: ["code", "feed", "brain"], locked: true },
			modules: { feed: { enabled: false }, browser: { home: "https://example.com", pins: [{ title: "Mail", url: "https://mail.example.com" }] } },
			agent: { claudePermission: "auto", agyPermission: "plan" },
			presets: [],
		});
		const once = normalizeSettings(JSON.parse(JSON.stringify(full)));
		expect(normalizeSettings(JSON.parse(JSON.stringify(once)))).toEqual(once);
		expect(once).toEqual(full);
		const legacy = normalizeSettings({ layout: { hiddenViews: ["server"] } });
		expect(normalizeSettings(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
		expect(normalizeSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)))).toEqual(normalizeSettings(DEFAULT_SETTINGS));
	});
});

describe("workspaceId", () => {
	test("is stable for one folder whatever the spelling on Windows", () => {
		expect(workspaceId("C:\\Users\\user\\TeezMind", "win32")).toBe(
			workspaceId("c:\\users\\user\\teezmind\\", "win32"),
		);
	});

	test("differs between folders", () => {
		expect(workspaceId("/a", "linux")).not.toBe(workspaceId("/b", "linux"));
	});
});

describe("firstRunWorkspaces", () => {
	test("pins the known project folders that exist, vault first", () => {
		const home = "C:\\Users\\user";
		const existing = new Set([
			"C:\\Users\\user\\TeezMind",
			"C:\\Users\\user\\Projects\\teezai",
		]);
		const pinned = firstRunWorkspaces({
			home,
			platform: "win32",
			isDirectory: (path) => existing.has(path),
		});
		expect(pinned.map((w) => w.name)).toEqual(["TeezMind", "teezai"]);
	});

	test("an empty machine pins nothing", () => {
		expect(
			firstRunWorkspaces({ home: "/home/x", platform: "linux", isDirectory: () => false }),
		).toEqual([]);
	});
});

describe("SettingsStore", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "teez-settings-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("first load seeds from the first-run list and writes the file", () => {
		const store = new SettingsStore(join(dir, "settings.json"), () => [
			{ id: "v", name: "Vault", path: "C:\\v" },
		]);
		expect(store.get().workspaces).toHaveLength(1);
		expect(store.get().activeWorkspaceId).toBe("v");
		expect(existsSync(join(dir, "settings.json"))).toBe(true);
	});

	test("update persists and notifies, leaving no temp file behind", () => {
		const file = join(dir, "settings.json");
		const store = new SettingsStore(file, () => []);
		const seen: number[] = [];
		store.onChange((settings) => seen.push(settings.layout.rightWidth));

		store.update((s) => ({ ...s, layout: { ...s.layout, rightWidth: 500 } }));

		expect(seen).toEqual([500]);
		expect(JSON.parse(readFileSync(file, "utf-8")).layout.rightWidth).toBe(500);
		expect(existsSync(`${file}.tmp`)).toBe(false);
		expect(new SettingsStore(file, () => []).get().layout.rightWidth).toBe(500);
	});

	test("a corrupt file is set aside, not lost, and defaults load", () => {
		const file = join(dir, "settings.json");
		writeFileSync(file, "{ not json");
		const store = new SettingsStore(file, () => []);
		expect(store.get().workspaces).toEqual([]);
		expect(existsSync(`${file}.corrupt`)).toBe(true);
	});

	test("pin adds once, unpin removes and moves the active one", () => {
		mkdirSync(join(dir, "a"));
		mkdirSync(join(dir, "b"));
		const store = new SettingsStore(join(dir, "settings.json"), () => []);

		const a = store.pin(join(dir, "a"));
		store.pin(join(dir, "a"));
		const b = store.pin(join(dir, "b"));
		expect(store.get().workspaces.map((w) => w.id)).toEqual([a.id, b.id]);
		expect(store.get().activeWorkspaceId).toBe(b.id);

		store.unpin(b.id);
		expect(store.get().workspaces.map((w) => w.id)).toEqual([a.id]);
		expect(store.get().activeWorkspaceId).toBe(a.id);
	});
});
