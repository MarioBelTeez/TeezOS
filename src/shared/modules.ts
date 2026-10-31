import { isBag, str, pick, clamp, clampFloat, bool } from "./normalize.ts";

export type ModuleId = "chat" | "editor" | "terminal" | "brain" | "feed" | "browser" | "agents" | "server" | "automations";
export const MODULE_IDS: readonly ModuleId[] = ["chat", "editor", "terminal", "brain", "feed", "browser", "agents", "server", "automations"];
export type TextSize = "s" | "m" | "l";
export type LabelMode = "always" | "zoom" | "never";
export type ShellChoice = "auto" | "powershell" | "gitbash" | "cmd";
export type BrowserPin = { readonly title: string; readonly url: string };
export type Modules = {
	readonly chat: { readonly enabled: true; readonly textSize: TextSize; readonly handover: boolean; readonly autoContinue: boolean };
	readonly editor: { readonly enabled: true; readonly fontSize: number; readonly wordWrap: boolean; readonly minimap: boolean; readonly tabSize: 2 | 4 };
	readonly terminal: { readonly enabled: boolean; readonly fontSize: number; readonly shell: ShellChoice; readonly cursorBlink: boolean };
	readonly brain: { readonly enabled: boolean; readonly repel: number; readonly linkDistance: number; readonly gravity: number; readonly labels: LabelMode; readonly colorByFolder: boolean };
	readonly feed: { readonly enabled: boolean };
	readonly browser: { readonly enabled: boolean; readonly home: string; readonly pins: readonly BrowserPin[] };
	readonly agents: { readonly enabled: boolean };
	readonly server: { readonly enabled: boolean };
	readonly automations: { readonly enabled: boolean };
};

export const DEFAULT_MODULES: Modules = {
	chat: { enabled: true, textSize: "m", handover: true, autoContinue: true },
	editor: { enabled: true, fontSize: 13, wordWrap: false, minimap: true, tabSize: 2 },
	terminal: { enabled: true, fontSize: 12.5, shell: "auto", cursorBlink: true },
	brain: { enabled: true, repel: 190, linkDistance: 70, gravity: 0.05, labels: "zoom", colorByFolder: true },
	feed: { enabled: true },
	browser: { enabled: true, home: "https://duckduckgo.com", pins: [{ title: "BelTeez Mail", url: "https://privateemail.com" }] },
	agents: { enabled: true },
	server: { enabled: true },
	automations: { enabled: true }
};

/** Longest browser URL kept in settings (home page, pins). */
export const MAX_BROWSER_URL = 2048;
/** Most pinned browser tabs kept in settings. */
export const MAX_BROWSER_PINS = 12;
/** Most browser tabs open at once (each is a page running in the main process). */
export const MAX_BROWSER_TABS = 40;

/** A web address the browser may open: parses, http(s), has a host, not absurdly long. */
export function isHttpUrl(url: string): boolean {
	if (url.length === 0 || url.length > MAX_BROWSER_URL) return false;
	try {
		const parsed = new URL(url);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
	} catch {
		return false;
	}
}

export function normalizeModules(raw: unknown, legacyHiddenViews: readonly string[]): Modules {
	const b = isBag(raw) ? raw : {};
	const chat = isBag(b["chat"]) ? b["chat"] : {};
	const editor = isBag(b["editor"]) ? b["editor"] : {};
	const terminal = isBag(b["terminal"]) ? b["terminal"] : {};
	const brain = isBag(b["brain"]) ? b["brain"] : {};
	const feed = isBag(b["feed"]) ? b["feed"] : {};
	const browser = isBag(b["browser"]) ? b["browser"] : {};
	const agents = isBag(b["agents"]) ? b["agents"] : {};
	const server = isBag(b["server"]) ? b["server"] : {};
	const automations = isBag(b["automations"]) ? b["automations"] : {};

	const browserHomeRaw = str(browser["home"]);
	const browserHome = browserHomeRaw && isHttpUrl(browserHomeRaw.trim()) ? browserHomeRaw.trim() : DEFAULT_MODULES.browser.home;

	let pins = DEFAULT_MODULES.browser.pins;
	if (Array.isArray(browser["pins"])) {
		const p: BrowserPin[] = [];
		for (const pin of browser["pins"]) {
			if (p.length >= MAX_BROWSER_PINS) break;
			if (isBag(pin)) {
				const title = str(pin["title"])?.trim() ?? "";
				const url = str(pin["url"])?.trim() ?? "";
				if (title !== "" && isHttpUrl(url)) {
					p.push({ title: title.slice(0, 40), url });
				}
			}
		}
		pins = p; // an explicit list wins, even an empty one: the user cleared their pins
	}

	return {
		chat: {
			enabled: true,
			textSize: pick(chat["textSize"], ["s", "m", "l"], DEFAULT_MODULES.chat.textSize),
			handover: bool(chat["handover"], DEFAULT_MODULES.chat.handover),
			autoContinue: bool(chat["autoContinue"], DEFAULT_MODULES.chat.autoContinue)
		},
		editor: {
			enabled: true,
			fontSize: clamp(editor["fontSize"], 10, 24, DEFAULT_MODULES.editor.fontSize),
			wordWrap: bool(editor["wordWrap"], DEFAULT_MODULES.editor.wordWrap),
			minimap: bool(editor["minimap"], DEFAULT_MODULES.editor.minimap),
			tabSize: editor["tabSize"] === 4 ? 4 : 2
		},
		terminal: {
			enabled: typeof terminal["enabled"] === "boolean" ? terminal["enabled"] : !legacyHiddenViews.includes("terminal"),
			fontSize: clampFloat(terminal["fontSize"], 9, 24, DEFAULT_MODULES.terminal.fontSize),
			shell: pick(terminal["shell"], ["auto", "powershell", "gitbash", "cmd"], DEFAULT_MODULES.terminal.shell),
			cursorBlink: bool(terminal["cursorBlink"], DEFAULT_MODULES.terminal.cursorBlink)
		},
		brain: {
			enabled: typeof brain["enabled"] === "boolean" ? brain["enabled"] : !legacyHiddenViews.includes("brain"),
			repel: clamp(brain["repel"], 30, 800, DEFAULT_MODULES.brain.repel),
			linkDistance: clamp(brain["linkDistance"], 20, 250, DEFAULT_MODULES.brain.linkDistance),
			gravity: clampFloat(brain["gravity"], 0, 0.5, DEFAULT_MODULES.brain.gravity),
			labels: pick(brain["labels"], ["always", "zoom", "never"], DEFAULT_MODULES.brain.labels),
			colorByFolder: bool(brain["colorByFolder"], DEFAULT_MODULES.brain.colorByFolder)
		},
		feed: {
			enabled: typeof feed["enabled"] === "boolean" ? feed["enabled"] : !legacyHiddenViews.includes("feed")
		},
		browser: {
			enabled: typeof browser["enabled"] === "boolean" ? browser["enabled"] : !legacyHiddenViews.includes("browser"),
			home: browserHome,
			pins
		},
		agents: {
			enabled: typeof agents["enabled"] === "boolean" ? agents["enabled"] : !legacyHiddenViews.includes("agents")
		},
		server: {
			enabled: typeof server["enabled"] === "boolean" ? server["enabled"] : !legacyHiddenViews.includes("server")
		},
		automations: {
			enabled: typeof automations["enabled"] === "boolean" ? automations["enabled"] : !legacyHiddenViews.includes("automations")
		}
	};
}

export function isModuleEnabled(modules: Modules, id: ModuleId): boolean {
	return modules[id].enabled;
}

export type ModulesPatch = { readonly [K in ModuleId]?: Partial<Modules[K]> };

/** Merge a per-module patch onto the current modules; unknown ids are ignored. Callers normalize the result. */
export function mergeModules(current: Modules, patch: unknown): Modules {
	if (typeof patch !== "object" || patch === null) return current;
	const bag = patch as Record<string, unknown>;
	const next: Record<string, unknown> = { ...current };
	for (const id of MODULE_IDS) {
		const part = bag[id];
		if (typeof part === "object" && part !== null) next[id] = { ...current[id], ...part };
	}
	return next as Modules;
}
