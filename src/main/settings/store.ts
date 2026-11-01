import { createHash } from "node:crypto";
import { CLAUDE_EFFORTS, type ClaudeEffort } from "../../shared/effort.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_DOCK, DEFAULT_VIEW_ORDER, normalizeDock, normalizeViews, type Dock, type ViewId } from "../../shared/dock.ts";
import { normalizeDesks, type Desk } from "../../shared/desks.ts";
import { PRESENCE_MODES, type PresenceMode } from "../discord/presence.ts";
import { isBag, str, pick, clamp, bool, type Bag } from "../../shared/normalize.ts";
import { DEFAULT_MODULES, normalizeModules, type Modules } from "../../shared/modules.ts";
import { normalizePresets, type Preset } from "../../shared/presets.ts";
import { VIEW_MODULE } from "../../shared/views.ts";

/**
 * Everything TeezAI remembers between runs, in one JSON file in `userData`.
 *
 * Secrets never live here (see secrets.ts). The file is rewritten atomically
 * — a temp file, then a rename over the old one — so a crash or power cut in
 * the middle of a save leaves the previous version, never half a file. A file
 * that does not parse is moved aside as `.corrupt` rather than overwritten,
 * so nothing the user set is silently thrown away.
 */

export type Workspace = {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	/** "initials": the tile shows letters even when the folder has a logo. */
	readonly icon?: "initials";
};

export type AgentKind = "claude" | "agy" | "codex";
/** Every permission mode TeezAI offers for Claude chats; the SDK's own names. */
export const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "auto", "plan", "bypassPermissions"] as const;
export type ClaudePermission = (typeof CLAUDE_PERMISSION_MODES)[number];
export type AgyPermission = "ask" | "plan" | "accept-edits" | "full-auto";
export type AgyEffort = "low" | "medium" | "high";
/** Codex (ChatGPT) modes: ask before every command and edit; auto-accept edits inside the workspace; no asking. */
export const CODEX_PERMISSION_MODES = ["ask", "auto-edit", "full-access"] as const;
export type CodexPermission = (typeof CODEX_PERMISSION_MODES)[number];
export type CodexEffort = "low" | "medium" | "high";

export type AgentSettings = {
	readonly defaultAgent: AgentKind;
	/** "" means the account default. */
	readonly claudeModel: string;
	readonly claudePermission: ClaudePermission;
	/** New Claude chats start at this effort; "" sends none (the model's default). */
	readonly claudeEffort: ClaudeEffort;
	readonly agyModel: string;
	readonly agyPermission: AgyPermission;
	readonly agyEffort: AgyEffort;
	/** "" means the account's default Codex model. */
	readonly codexModel: string;
	readonly codexPermission: CodexPermission;
	readonly codexEffort: CodexEffort;
	/** A Windows notification when a chat finishes or waits, while the window is in the background. */
	readonly notify: boolean;
	/** Discord status: "private" shows what is happening but never a workspace name. */
	readonly presence: PresenceMode;
};

/**
 * The desks along the top (see shared/desks.ts), the left bar's views, and the
 * 0.2.3 dock, which seeds a desk's first layout.
 */
export type LayoutSettings = {
	readonly leftWidth: number;
	readonly rightWidth: number;
	readonly bottomHeight: number;
	readonly leftOpen: boolean;
	readonly rightOpen: boolean;
	readonly bottomOpen: boolean;
	/** Which panels each area holds, in tab order. */
	readonly dock: Dock;
	readonly viewOrder: readonly ViewId[];
	readonly hiddenViews: readonly ViewId[];
	readonly desks: readonly Desk[];
	readonly activeDeskId: string;
	/** Panels stay where they are: no dragging tabs or groups. */
	readonly locked: boolean;
};

export type ProxmoxSettings = {
	readonly baseUrl: string;
	readonly node: string;
	/** `user@realm!tokenname`; the secret half lives in secrets.ts. */
	readonly tokenId: string;
	/** SHA-256 certificate fingerprint the connection is pinned to. */
	readonly fingerprint: string;
	/** The cluster's root CA (public), which signed the web certificate. */
	readonly ca: string;
};

export type RunnerSettings = {
	readonly baseUrl: string;
	/** Pinned certificate: the runner's self-signed cert and its fingerprint. */
	readonly fingerprint: string;
	readonly ca: string;
	readonly vmid: number;
};

export type Settings = {
	readonly version: 1;
	readonly workspaces: readonly Workspace[];
	readonly activeWorkspaceId: string | null;
	readonly vaultPath: string | null;
	readonly agent: AgentSettings;
	readonly layout: LayoutSettings;
	readonly modules: Modules;
	readonly presets: readonly Preset[];
	readonly proxmox: ProxmoxSettings | null;
	readonly runner: RunnerSettings | null;
};

export const DEFAULT_SETTINGS: Settings = {
	version: 1,
	workspaces: [],
	activeWorkspaceId: null,
	vaultPath: null,
	agent: {
		defaultAgent: "claude",
		claudeModel: "",
		claudePermission: "auto",
		claudeEffort: "",
		agyModel: "",
		agyPermission: "accept-edits",
		agyEffort: "medium",
		codexModel: "",
		codexPermission: "ask",
		codexEffort: "medium",
		notify: true,
		presence: "on",
	},
	layout: {
		leftWidth: 260,
		rightWidth: 460,
		bottomHeight: 240,
		leftOpen: true,
		rightOpen: true,
		bottomOpen: false,
		dock: DEFAULT_DOCK,
		viewOrder: DEFAULT_VIEW_ORDER,
		hiddenViews: [],
		desks: [{ id: "desk-1", name: "", workspaceId: "", grid: null }],
		activeDeskId: "desk-1",
		locked: false,
	},
	modules: DEFAULT_MODULES,
	presets: [],
	proxmox: null,
	runner: null,
};

function normalizeWorkspaces(value: unknown): Workspace[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const result: Workspace[] = [];
	for (const item of value) {
		if (!isBag(item)) continue;
		const id = str(item["id"]);
		const wsPath = str(item["path"]);
		if (!id || !wsPath || seen.has(id)) continue;
		seen.add(id);
		const name = str(item["name"])?.trim() || path.basename(wsPath) || wsPath;
		result.push({ id, name, path: wsPath, ...(item["icon"] === "initials" ? { icon: "initials" as const } : {}) });
	}
	return result;
}

function normalizeProxmox(value: unknown): ProxmoxSettings | null {
	if (!isBag(value)) return null;
	const baseUrl = str(value["baseUrl"]);
	const node = str(value["node"]);
	const tokenId = str(value["tokenId"]);
	const fingerprint = str(value["fingerprint"]);
	const ca = str(value["ca"]);
	if (!baseUrl || !node || !tokenId || !fingerprint || !ca) return null;
	return { baseUrl, node, tokenId, fingerprint, ca };
}

export function normalizeSettings(raw: unknown): Settings {
	if (!isBag(raw)) return DEFAULT_SETTINGS;
	const d = DEFAULT_SETTINGS;

	const workspaces = normalizeWorkspaces(raw["workspaces"]);
	const wantedActive = str(raw["activeWorkspaceId"]);
	const activeWorkspaceId = workspaces.some((w) => w.id === wantedActive)
		? wantedActive
		: (workspaces[0]?.id ?? null);

	const agent = isBag(raw["agent"]) ? raw["agent"] : {};
	const layout = isBag(raw["layout"]) ? raw["layout"] : {};
	const views = normalizeViews(layout["viewOrder"], layout["hiddenViews"]);
	const runnerBag = isBag(raw["runner"]) ? raw["runner"] : null;
	const runner =
		runnerBag && str(runnerBag["baseUrl"]) && str(runnerBag["fingerprint"]) && str(runnerBag["ca"])
			? {
					baseUrl: str(runnerBag["baseUrl"]) ?? "",
					fingerprint: str(runnerBag["fingerprint"]) ?? "",
					ca: str(runnerBag["ca"]) ?? "",
					vmid: typeof runnerBag["vmid"] === "number" ? runnerBag["vmid"] : 104,
				}
			: null;

	return {
		version: 1,
		workspaces,
		activeWorkspaceId,
		vaultPath: str(raw["vaultPath"]),
		agent: {
			defaultAgent: pick(agent["defaultAgent"], ["claude", "agy", "codex"], d.agent.defaultAgent),
			claudeModel: str(agent["claudeModel"]) ?? d.agent.claudeModel,
			claudePermission: pick(
				agent["claudePermission"],
				CLAUDE_PERMISSION_MODES,
				d.agent.claudePermission,
			),
			claudeEffort: pick(agent["claudeEffort"], CLAUDE_EFFORTS, d.agent.claudeEffort),
			agyModel: str(agent["agyModel"]) ?? d.agent.agyModel,
			agyPermission: pick(
				agent["agyPermission"],
				["ask", "plan", "accept-edits", "full-auto"],
				d.agent.agyPermission,
			),
			agyEffort: pick(agent["agyEffort"], ["low", "medium", "high"], d.agent.agyEffort),
			codexModel: str(agent["codexModel"]) ?? d.agent.codexModel,
			codexPermission: pick(agent["codexPermission"], CODEX_PERMISSION_MODES, d.agent.codexPermission),
			codexEffort: pick(agent["codexEffort"], ["low", "medium", "high"], d.agent.codexEffort),
			notify: bool(agent["notify"], d.agent.notify),
			presence: pick(agent["presence"], PRESENCE_MODES, d.agent.presence),
		},
		// Before the dock (0.2.x) the areas were the side panel, the chat and the
		// terminal; their saved sizes and states carry over.
		layout: {
			leftWidth: clamp(layout["leftWidth"] ?? layout["sidePanelWidth"], 160, 1200, d.layout.leftWidth),
			rightWidth: clamp(layout["rightWidth"] ?? layout["chatWidth"], 160, 1200, d.layout.rightWidth),
			bottomHeight: clamp(layout["bottomHeight"] ?? layout["terminalHeight"], 100, 900, d.layout.bottomHeight),
			leftOpen: bool(layout["leftOpen"] ?? layout["sidePanelOpen"], d.layout.leftOpen),
			rightOpen: bool(layout["rightOpen"] ?? layout["chatOpen"], d.layout.rightOpen),
			bottomOpen: bool(layout["bottomOpen"] ?? layout["terminalOpen"], d.layout.bottomOpen),
			dock: normalizeDock(layout["dock"]),
			viewOrder: views.order,
			// A 0.2.6 file (no modules yet): its hidden views become disabled modules below, so they
			// leave this list, or turning the module back on would never bring the view back.
			hiddenViews: isBag(raw["modules"]) ? views.hidden : views.hidden.filter((v) => VIEW_MODULE[v] === "editor"),
			...normalizeDesks(layout["desks"], layout["activeDeskId"], workspaces.map((w) => w.id), activeWorkspaceId),
			locked: bool(layout["locked"], d.layout.locked),
		},
		modules: normalizeModules(raw["modules"], views.hidden),
		presets: normalizePresets(raw["presets"]),
		proxmox: normalizeProxmox(raw["proxmox"]),
		runner,
	};
}

/**
 * A short id that is the same however the folder is spelled. Windows paths
 * are case-insensitive, so `C:\Users\X` and `c:\users\x\` are one workspace.
 */
export function workspaceId(folder: string, platform: NodeJS.Platform = process.platform): string {
	const api = platform === "win32" ? path.win32 : path.posix;
	let normal = api.normalize(folder);
	while (normal.length > 1 && (normal.endsWith("\\") || normal.endsWith("/"))) {
		normal = normal.slice(0, -1);
	}
	if (platform === "win32") normal = normal.toLowerCase();
	return createHash("sha1").update(normal).digest("hex").slice(0, 10);
}

/**
 * The folders worth pinning on a first launch, in order, where they exist.
 * The vault comes first: it is where TeezAI starts and what Brain reads.
 */
export function firstRunWorkspaces(deps: {
	readonly home: string;
	readonly platform: NodeJS.Platform;
	readonly isDirectory: (path: string) => boolean;
}): Workspace[] {
	const api = deps.platform === "win32" ? path.win32 : path.posix;
	const candidates = [
		["TeezMind"],
		["Projects", "teezai"],
	];
	const result: Workspace[] = [];
	for (const parts of candidates) {
		const folder = api.join(deps.home, ...parts);
		if (!deps.isDirectory(folder)) continue;
		result.push({
			id: workspaceId(folder, deps.platform),
			name: parts[parts.length - 1] ?? folder,
			path: folder,
		});
	}
	return result;
}

function isDirectory(folder: string): boolean {
	try {
		return statSync(folder).isDirectory();
	} catch {
		return false;
	}
}

export class SettingsStore {
	readonly #file: string;
	#settings: Settings;
	readonly #listeners = new Set<(settings: Settings) => void>();

	constructor(file: string, seed: () => readonly Workspace[]) {
		this.#file = file;
		this.#settings = this.#load(seed);
	}

	get(): Settings {
		return this.#settings;
	}

	onChange(listener: (settings: Settings) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	update(change: (settings: Settings) => Settings): Settings {
		this.#settings = normalizeSettings(change(this.#settings));
		this.#save();
		for (const listener of this.#listeners) listener(this.#settings);
		return this.#settings;
	}

	/** Pin a folder (or find it if already pinned) and make it active. */
	pin(folder: string): Workspace {
		const resolved = path.resolve(folder);
		if (!isDirectory(resolved)) throw new Error(`Not a folder: ${resolved}`);
		const id = workspaceId(resolved);
		const existing = this.#settings.workspaces.find((w) => w.id === id);
		const workspace = existing ?? { id, name: path.basename(resolved) || resolved, path: resolved };
		this.update((s) => ({
			...s,
			workspaces: existing ? s.workspaces : [...s.workspaces, workspace],
			activeWorkspaceId: id,
		}));
		return workspace;
	}

	unpin(id: string): void {
		this.update((s) => {
			const workspaces = s.workspaces.filter((w) => w.id !== id);
			const activeWorkspaceId =
				s.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeWorkspaceId;
			return { ...s, workspaces, activeWorkspaceId };
		});
	}

	setActive(id: string): void {
		if (!this.#settings.workspaces.some((w) => w.id === id)) return;
		this.update((s) => ({ ...s, activeWorkspaceId: id }));
	}

	#load(seed: () => readonly Workspace[]): Settings {
		if (!existsSync(this.#file)) {
			const seeded = seed();
			this.#settings = normalizeSettings({
				...DEFAULT_SETTINGS,
				workspaces: seeded,
				activeWorkspaceId: seeded[0]?.id ?? null,
			});
			this.#save();
			return this.#settings;
		}
		try {
			return normalizeSettings(JSON.parse(readFileSync(this.#file, "utf-8")));
		} catch {
			try {
				renameSync(this.#file, `${this.#file}.corrupt`);
			} catch {
				// Could not move it aside; loading defaults is still right.
			}
			return DEFAULT_SETTINGS;
		}
	}

	#save(): void {
		mkdirSync(path.dirname(this.#file), { recursive: true });
		const temp = `${this.#file}.tmp`;
		writeFileSync(temp, `${JSON.stringify(this.#settings, null, 2)}\n`, "utf-8");
		renameSync(temp, this.#file);
	}
}
