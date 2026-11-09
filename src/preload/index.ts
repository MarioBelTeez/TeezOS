import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { UiEvent } from "../main/claude/events.ts";
import type { ApprovalRequest } from "../main/claude/service.ts";
import type { UpdateStatus } from "../main/update/updater.ts";
import type { Settings, Workspace, LayoutSettings, AgentSettings } from "../main/settings/store.ts";
import type { ModulesPatch, ShellChoice } from "../shared/modules.ts";
import type { Preset } from "../shared/presets.ts";
import type { FileContent, ListResult, WriteResult } from "../main/workspace/files.ts";
import type { GitCommit, GitStatus } from "../main/workspace/git.ts";
import type { FsChange } from "../main/workspace/watcher.ts";
import type { AgentKind, SlashCommandInfo } from "../main/agents/registry.ts";
import type { PauseChange } from "../main/agents/auto-continue.ts";
import type { BtwEvent } from "../main/agents/btw-service.ts";
import type { SearchHit } from "../main/workspace/search.ts";
import type { GitResult } from "../main/workspace/git-write.ts";
import type { FeedItem, FeedKind } from "../shared/feed.ts";
import type { EngineId, EngineStatus, FeedPrefs } from "../shared/feed-engine.ts";
import type { VaultSource } from "../shared/feed-history.ts";
import type { ModelChoices } from "../main/ipc/feed.ts";
import type { AgyUsage, ClaudeUsage } from "../shared/usage.ts";
import type { DraftPreview, SkillResult } from "../main/feed/skills.ts";
import type { HistoryItem, SessionSummary } from "../main/sessions/history.ts";
import type { SessionDeleteResult } from "../main/ipc/chat.ts";
import type { TerminalInfo, TerminalProfile } from "../main/terminal/service.ts";
import type { NoteView, VaultIndex } from "../main/brain/vault.ts";
import type { BrainHit } from "../main/brain/search.ts";
import type { ServerOverview } from "../main/ipc/server.ts";
import type { JobView, RunItem } from "../main/ipc/automations.ts";
import type { Health, Run } from "../../runner/src/types.ts";
import type {
	BrowserAction,
	BrowserDownload,
	BrowserDownloadAsk,
	BrowserForwardedKey,
	BrowserFound,
	BrowserPermissionRequest,
	BrowserRefused,
	BrowserShortcut,
	BrowserTabState,
	Rect,
} from "../main/browser/manager.ts";

/**
 * The entire surface the renderer is allowed to touch. Every addition here is
 * a hole in the sandbox, so each one stays narrow and typed: the renderer asks
 * for an action, the main process decides whether it is allowed.
 */

export type ClaudeStatus =
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly reason: string };

export type ChatEvent = { readonly chatId: string; readonly event: UiEvent };
export type ChatPause = PauseChange;
export type ChatApproval = { readonly chatId: string; readonly request: ApprovalRequest };
export type FsChangeEvent = FsChange & { readonly workspaceId: string };

export type ServerResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export type CreateChatRequest = {
	readonly workspaceId: string;
	readonly agent?: AgentKind;
	readonly model?: string;
	readonly permission?: string;
	readonly effort?: string;
	readonly resume?: string;
};

/** Subscribe to a channel; returns the unsubscribe function React needs. */
function on<T>(channel: string, handler: (payload: T) => void): () => void {
	const listener = (_: unknown, payload: T): void => handler(payload);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.removeListener(channel, listener);
}

const teez = {
	app: {
		info: (): Promise<{ version: string; electron: string; platform: string; userData: string }> =>
			ipcRenderer.invoke("app:info"),
		/** Start with Windows. Pass nothing to read; null in a dev run. */
		loginItem: (enable?: boolean): Promise<boolean | null> => ipcRenderer.invoke("app:login-item", enable),
	},
	window: {
		/** Tells the main process how many files are unsaved, so closing can ask first. */
		reportUnsaved: (count: number): void => ipcRenderer.send("editor:unsaved", count),
		minimize: (): void => ipcRenderer.send("window:minimize"),
		toggleMaximize: (): void => ipcRenderer.send("window:toggle-maximize"),
		close: (): void => ipcRenderer.send("window:close"),
	},
	settings: {
		get: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
		update: (patch: {
			readonly onboardingCompleted?: boolean;
			readonly layout?: Partial<LayoutSettings>;
			readonly agent?: Partial<AgentSettings>;
			readonly modules?: ModulesPatch;
			readonly presets?: readonly Preset[];
		}): Promise<Settings> => ipcRenderer.invoke("settings:update", patch),
		onChange: (handler: (settings: Settings) => void) => on("settings:changed", handler),
	},
	workspaces: {
		/** Opens the folder picker in the main process. */
		pin: (): Promise<Workspace | null> => ipcRenderer.invoke("workspace:pin-dialog"),
		unpin: (id: string): Promise<void> => ipcRenderer.invoke("workspace:unpin", id),
		activate: (id: string): Promise<void> => ipcRenderer.invoke("workspace:activate", id),
		reorder: (ids: readonly string[]): Promise<void> => ipcRenderer.invoke("workspace:reorder", ids),
		reveal: (id: string, path: string): Promise<void> =>
			ipcRenderer.invoke("workspace:reveal", id, path),
		/** The folder's logo as a data URL, or null for initials. */
		icon: (id: string): Promise<{ readonly dataUrl: string; readonly source: string } | null> => ipcRenderer.invoke("workspace:icon", id),
		/** A native picker; the image is copied into the app's data folder. */
		pickIcon: (id: string): Promise<{ ok: true } | { ok: false; reason: string }> => ipcRenderer.invoke("workspace:pick-icon", id),
		/** "logo" forgets a picked image and uses the folder's own; "initials" shows letters. */
		iconMode: (id: string, mode: "logo" | "initials"): Promise<void> => ipcRenderer.invoke("workspace:icon-mode", id, mode),
	},
	files: {
		list: (id: string, path: string): Promise<ListResult> => ipcRenderer.invoke("files:list", id, path),
		read: (id: string, path: string): Promise<FileContent> => ipcRenderer.invoke("files:read", id, path),
		write: (id: string, path: string, content: string): Promise<WriteResult> =>
			ipcRenderer.invoke("files:write", id, path, content),
		create: (id: string, path: string, kind: "file" | "dir"): Promise<WriteResult> =>
			ipcRenderer.invoke("files:create", id, path, kind),
		rename: (id: string, from: string, to: string): Promise<WriteResult> =>
			ipcRenderer.invoke("files:rename", id, from, to),
		/** Asks for confirmation in a native dialog before anything is deleted. */
		delete: (id: string, path: string): Promise<WriteResult> => ipcRenderer.invoke("files:delete", id, path),
		/** Every file path in the workspace (respecting .gitignore), for quick open. */
		index: (id: string): Promise<string[]> => ipcRenderer.invoke("files:index", id),
		search: (
			id: string,
			query: string,
			options: { readonly caseSensitive: boolean; readonly regex: boolean },
		): Promise<SearchHit[]> => ipcRenderer.invoke("files:search", id, query, options),
		onChange: (handler: (change: FsChangeEvent) => void) => on("fs:changed", handler),
		/** The disk path of a dropped file ("" when it has none). Electron 44 has no File.path. */
		pathFor: (file: File): string => webUtils.getPathForFile(file),
	},
	git: {
		status: (id: string): Promise<GitStatus | null> => ipcRenderer.invoke("git:status", id),
		head: (id: string, path: string): Promise<string | null> => ipcRenderer.invoke("git:head", id, path),
		log: (id: string): Promise<GitCommit[]> => ipcRenderer.invoke("git:log", id),
		/** Stages and commits exactly these paths — never everything. */
		commit: (id: string, paths: readonly string[], message: string): Promise<GitResult> =>
			ipcRenderer.invoke("git:commit", id, paths, message),
		push: (id: string): Promise<GitResult> => ipcRenderer.invoke("git:push", id),
		pull: (id: string): Promise<GitResult> => ipcRenderer.invoke("git:pull", id),
	},
	chat: {
		claudeStatus: (): Promise<ClaudeStatus> => ipcRenderer.invoke("claude:status"),
		create: (request: CreateChatRequest): Promise<string | null> => ipcRenderer.invoke("chat:create", request),
		send: (chatId: string, text: string, images?: readonly { mediaType: string; data: string }[]): void =>
			ipcRenderer.send("chat:send", chatId, text, images ?? []),
		approve: (chatId: string, id: string, decision: "allow" | "deny"): void =>
			ipcRenderer.send("chat:approve", chatId, id, decision),
		stop: (chatId: string): void => ipcRenderer.send("chat:stop", chatId),
		close: (chatId: string): void => ipcRenderer.send("chat:close", chatId),
		setModel: (chatId: string, model: string): Promise<void> =>
			ipcRenderer.invoke("chat:set-model", chatId, model),
		setPermission: (chatId: string, mode: string): Promise<void> =>
			ipcRenderer.invoke("chat:set-permission", chatId, mode),
		setEffort: (chatId: string, effort: string): Promise<void> => ipcRenderer.invoke("chat:set-effort", chatId, effort),
		/** The chat's slash commands with descriptions; empty before its first message. */
		commands: (chatId: string): Promise<SlashCommandInfo[]> => ipcRenderer.invoke("chat:commands", chatId),
		onEvent: (handler: (event: ChatEvent) => void) => on("chat:event", handler),
		onApproval: (handler: (approval: ChatApproval) => void) => on("chat:approval", handler),
		/** A chat is waiting for a plan limit to reset, was resumed by itself, or its wait ended. */
		onPause: (handler: (change: ChatPause) => void) => on("chat:pause", handler),
		/** Cancel the chat's automatic continue. */
		cancelPause: (chatId: string): void => ipcRenderer.send("chat:cancel-pause", chatId),
		/** A click on a "finished" or "waiting" notification: show that chat. */
		onFocus: (handler: (target: { readonly chatId: string; readonly workspaceId: string }) => void) => on("chat:focus", handler),
	},
	btw: {
		/** A side question about the chat; its answer streams as events under the returned id. */
		ask: (chatId: string, question: string): Promise<string | { readonly error: string }> =>
			ipcRenderer.invoke("btw:ask", chatId, question),
		cancel: (btwId: string): void => ipcRenderer.send("btw:cancel", btwId),
		onEvent: (handler: (event: BtwEvent) => void) => on("btw:event", handler),
	},
	terminal: {
		create: (request: {
			readonly workspaceId: string;
			readonly profile: TerminalProfile;
			readonly cols: number;
			readonly rows: number;
			readonly vmid?: number;
			readonly shell?: ShellChoice;
			/** For "claude-resume-remote": the Claude session to hand over to the phone. */
			readonly sessionId?: string;
		}): Promise<TerminalInfo | { readonly error: string } | null> => ipcRenderer.invoke("terminal:create", request),
		/** What the automatic shell is here and whether Git Bash is installed, for Settings → Terminal. */
		shells: (): Promise<{ readonly auto: string; readonly gitBash: boolean }> => ipcRenderer.invoke("terminal:shells"),
		write: (id: string, data: string): void => ipcRenderer.send("terminal:write", id, data),
		resize: (id: string, cols: number, rows: number): void => ipcRenderer.send("terminal:resize", id, cols, rows),
		kill: (id: string): void => ipcRenderer.send("terminal:kill", id),
		onData: (handler: (payload: { readonly id: string; readonly data: string }) => void) => on("terminal:data", handler),
		onExit: (handler: (payload: { readonly id: string; readonly exitCode: number }) => void) => on("terminal:exit", handler),
	},
	brain: {
		index: (): Promise<(VaultIndex & { readonly root: string }) | null> => ipcRenderer.invoke("brain:index"),
		note: (path: string): Promise<NoteView | null> => ipcRenderer.invoke("brain:note", path),
		search: (query: string, deep: boolean): Promise<{ hits: BrainHit[]; engine: string }> =>
			ipcRenderer.invoke("brain:search", query, deep),
		openInObsidian: (path: string): Promise<void> => ipcRenderer.invoke("brain:open-in-obsidian", path),
		defaultStarterPath: (): Promise<{ readonly path: string; readonly exists: boolean }> =>
			ipcRenderer.invoke("brain:default-starter-path"),
		pickExisting: (): Promise<{ readonly ok: true; readonly workspace: Workspace } | { readonly ok: false; readonly reason: string }> =>
			ipcRenderer.invoke("brain:pick-existing"),
		pickParentDir: (): Promise<string | null> => ipcRenderer.invoke("brain:pick-parent-dir"),
		createStarter: (options: {
			readonly targetDir?: string | undefined;
			readonly userName?: string | undefined;
			readonly goals?: readonly string[] | undefined;
			readonly useCases?: readonly string[] | undefined;
		}): Promise<{ readonly ok: true; readonly workspace: Workspace; readonly createdFiles: number } | { readonly ok: false; readonly reason: string }> =>
			ipcRenderer.invoke("brain:create-starter", options),
		personalizeStarter: (options: {
			readonly userName?: string | undefined;
			readonly goals?: readonly string[] | undefined;
			readonly useCases?: readonly string[] | undefined;
		}): Promise<{ readonly ok: boolean; readonly reason?: string }> =>
			ipcRenderer.invoke("brain:personalize-starter", options),
	},
	server: {
		/** A click on a server notification. */
		onOpen: (handler: () => void) => on("server:open", handler),
		status: (): Promise<{ configured: boolean; baseUrl: string | null; node: string | null; tokenId: string | null }> =>
			ipcRenderer.invoke("server:status"),
		/** Creates a limited API token over `ssh <alias>` and pins the certificate. */
		setup: (alias: string): Promise<ServerResult<string>> => ipcRenderer.invoke("server:setup", alias),
		disconnect: (): Promise<void> => ipcRenderer.invoke("server:disconnect"),
		overview: (): Promise<ServerResult<ServerOverview>> => ipcRenderer.invoke("server:overview"),
		/** Asks for confirmation in a native dialog, except for start. */
		guestAction: (type: "lxc" | "qemu", vmid: number, action: "start" | "stop" | "shutdown" | "reboot"): Promise<ServerResult<string>> =>
			ipcRenderer.invoke("server:guest-action", type, vmid, action),
		backupNow: (vmid: number, storage: string): Promise<ServerResult<string>> => ipcRenderer.invoke("server:backup-now", vmid, storage),
		hostAction: (action: "reboot" | "shutdown"): Promise<ServerResult<string>> => ipcRenderer.invoke("server:host-action", action),
	},
	automations: {
		status: (): Promise<{ configured: boolean; baseUrl: string | null }> => ipcRenderer.invoke("auto:status"),
		/** Reads the runner's token and certificate over `ssh <alias> pct exec <vmid>`. */
		connect: (alias: string, vmid: number): Promise<ServerResult<string>> => ipcRenderer.invoke("auto:connect", alias, vmid),
		disconnect: (): Promise<void> => ipcRenderer.invoke("auto:disconnect"),
		health: (): Promise<ServerResult<Health>> => ipcRenderer.invoke("auto:health"),
		jobs: (): Promise<ServerResult<JobView[]>> => ipcRenderer.invoke("auto:jobs"),
		saveJob: (id: string | null, job: unknown): Promise<ServerResult<JobView>> => ipcRenderer.invoke("auto:save-job", id, job),
		/** Asks for confirmation in a native dialog. */
		deleteJob: (id: string, name: string): Promise<ServerResult<unknown>> => ipcRenderer.invoke("auto:delete-job", id, name),
		runJob: (id: string): Promise<ServerResult<Run>> => ipcRenderer.invoke("auto:run-job", id),
		runs: (jobId: string | null): Promise<ServerResult<Run[]>> => ipcRenderer.invoke("auto:runs", jobId),
		run: (runId: string): Promise<ServerResult<{ run: Run; items: RunItem[] }>> => ipcRenderer.invoke("auto:run", runId),
		cancelRun: (runId: string): Promise<ServerResult<unknown>> => ipcRenderer.invoke("auto:cancel-run", runId),
		setClaudeToken: (token: string): Promise<ServerResult<unknown>> => ipcRenderer.invoke("auto:set-claude-token", token),
		onOpenRun: (handler: (runId: string) => void) => on("auto:open-run", handler),
	},
	edit: {
		/** Pastes the clipboard into whatever has focus, as Ctrl+V does. */
		paste: (): void => ipcRenderer.send("edit:paste"),
	},
	nav: {
		/** Windows' browser-back / browser-forward mouse buttons, with the pointer's place in the window. */
		onCommand: (handler: (command: { readonly direction: "back" | "forward"; readonly x: number; readonly y: number }) => void) => on("nav:command", handler),
	},
	browser: {
		/** A tab with this id (lowercase letters, digits, dashes) showing the URL, or a search for the text. */
		create: (tabId: string, url: string): void => ipcRenderer.send("browser:create", tabId, url),
		navigate: (tabId: string, input: string): void => ipcRenderer.send("browser:navigate", tabId, input),
		action: (tabId: string, action: BrowserAction): void => ipcRenderer.send("browser:action", tabId, action),
		/** Where the panel's page area is, in window pixels; null hides the tab. */
		bounds: (tabId: string, rect: Rect | null): void => ipcRenderer.send("browser:bounds", tabId, rect),
		find: (tabId: string, text: string, forward: boolean): void => ipcRenderer.send("browser:find", tabId, text, forward),
		stopFind: (tabId: string): void => ipcRenderer.send("browser:stop-find", tabId),
		zoom: (tabId: string, delta: -1 | 0 | 1): void => ipcRenderer.send("browser:zoom", tabId, delta),
		answerPermission: (requestId: string, allow: boolean): void => ipcRenderer.send("browser:permission", requestId, allow),
		/** Save or Cancel on a download question. */
		answerDownload: (id: string, save: boolean): void => ipcRenderer.send("browser:download-answer", id, save),
		close: (tabId: string): void => ipcRenderer.send("browser:close", tabId),
		/** The tab's current page in the system browser. */
		openExternal: (tabId: string): void => ipcRenderer.send("browser:open-external", tabId),
		/** Cookies, storage, cache and logins of the browser panel's session (not the app's). */
		clearData: (): Promise<{ ok: true } | { ok: false; message: string }> => ipcRenderer.invoke("browser:clear-data"),
		onState: (handler: (state: BrowserTabState) => void) => on("browser:state", handler),
		onFound: (handler: (found: BrowserFound) => void) => on("browser:found", handler),
		onPermission: (handler: (request: BrowserPermissionRequest) => void) => on("browser:permission", handler),
		/** A permission question answered, timed out, or its tab closed. */
		onPermissionDone: (handler: (done: { readonly requestId: string }) => void) => on("browser:permission-done", handler),
		onDownload: (handler: (download: BrowserDownload) => void) => on("browser:download", handler),
		/** A page wants to save a file: nothing is saved until Save is clicked. */
		onDownloadAsk: (handler: (ask: BrowserDownloadAsk) => void) => on("browser:download-ask", handler),
		/** A download question answered, timed out, or its tab closed. */
		onDownloadAsked: (handler: (done: { readonly id: string }) => void) => on("browser:download-asked", handler),
		/** A page opened a popup or target=_blank link. */
		onOpenTab: (handler: (request: { readonly url: string }) => void) => on("browser:open-tab", handler),
		/** A link clicked in the app (chat, notes) to show in the browser panel. */
		onOpenRequest: (handler: (request: { readonly url: string }) => void) => on("browser:open-request", handler),
		/** A tab the main process would not open; drop it from the strip. */
		onRefused: (handler: (refused: BrowserRefused) => void) => on("browser:refused", handler),
		onShortcut: (handler: (shortcut: BrowserShortcut) => void) => on("browser:shortcut", handler),
		/** An app shortcut pressed while a page had the focus. */
		onKey: (handler: (key: BrowserForwardedKey) => void) => on("browser:key", handler),
	},
	feed: {
		list: (): Promise<FeedItem[]> => ipcRenderer.invoke("feed:list"),
		/** A link or a file path; the main process decides what it is. */
		add: (source: string, kind: FeedKind, note: string): Promise<FeedItem | { readonly error: string }> =>
			ipcRenderer.invoke("feed:add", source, kind, note),
		retry: (id: string): Promise<void> => ipcRenderer.invoke("feed:retry", id),
		cancel: (id: string): Promise<void> => ipcRenderer.invoke("feed:cancel", id),
		remove: (id: string): Promise<void> => ipcRenderer.invoke("feed:remove", id),
		/** SKILL.md, every file and a digest of the draft, for the confirm dialog; or why it cannot be installed. */
		previewSkill: (name: string): Promise<DraftPreview> => ipcRenderer.invoke("feed:preview-skill", name),
		/** Copies thinking/skill-drafts/<name> into .claude/skills/<name> if it still matches the reviewed digest; never overwrites. */
		installSkill: (name: string, digest: string): Promise<SkillResult> => ipcRenderer.invoke("feed:install-skill", name, digest),
		discardSkill: (name: string): Promise<SkillResult> => ipcRenderer.invoke("feed:discard-skill", name),
		/** Whether a Groq key is saved; the key itself never comes back. */
		hasGroq: (): Promise<boolean> => ipcRenderer.invoke("feed:has-groq"),
		setGroq: (key: string): Promise<{ ok: true } | { ok: false; message: string }> => ipcRenderer.invoke("feed:set-groq", key),
		/** Whether a Gemini (AI Studio) key is saved; the key itself never comes back. */
		hasGemini: (): Promise<boolean> => ipcRenderer.invoke("feed:has-gemini"),
		setGemini: (key: string): Promise<{ ok: true } | { ok: false; message: string }> => ipcRenderer.invoke("feed:set-gemini", key),
		/** The saved engine and model choice. */
		prefs: (): Promise<FeedPrefs> => ipcRenderer.invoke("feed:prefs"),
		setPrefs: (prefs: FeedPrefs): Promise<FeedPrefs> => ipcRenderer.invoke("feed:set-prefs", prefs),
		/** The engine in use, its model, which keys exist (as booleans) and the last quota error. */
		engineStatus: (): Promise<EngineStatus> => ipcRenderer.invoke("feed:engine-status"),
		/** The engine's models, fetched in the main process from its list endpoint. */
		models: (engine: EngineId): Promise<ModelChoices> => ipcRenderer.invoke("feed:models", engine),
		/** Source notes in the vault that a feed job wrote (frontmatter only). */
		history: (): Promise<VaultSource[]> => ipcRenderer.invoke("feed:history"),
		onChange: (handler: (items: FeedItem[]) => void) => on("feed:changed", handler),
	},
	phone: {
		/** Sends the saved Gemini and Groq keys to the phone server over SSH; the keys never reach the window. */
		sendKeys: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke("phone:send-keys"),
	},
	agents: {
		agyStatus: (): Promise<{ available: boolean; models: { id: string; label: string }[] }> =>
			ipcRenderer.invoke("agents:agy-status"),
		/** Whether Codex can run: installed, a supported version, logged in; and the account's models. */
		codexStatus: (): Promise<{ available: boolean; reason?: "codex-not-found" | "codex-logged-out" | "codex-unsupported"; version?: string; models: { id: string; label: string }[] }> =>
			ipcRenderer.invoke("agents:codex-status"),
		/** Claude's plan limits from an open Claude chat; null when none can say. */
		usage: (): Promise<ClaudeUsage | null> => ipcRenderer.invoke("usage:get"),
		/** Antigravity's plan limits from `agy -p "/usage" --output-format json`; null when unavailable. */
		agyUsage: (): Promise<AgyUsage | null> => ipcRenderer.invoke("usage:agy-get"),
	},
	sessions: {
		list: (workspaceId: string): Promise<SessionSummary[]> => ipcRenderer.invoke("sessions:list", workspaceId),
		transcript: (workspaceId: string, sessionId: string): Promise<HistoryItem[]> =>
			ipcRenderer.invoke("sessions:transcript", workspaceId, sessionId),
		/** Moves the session to the Recycle Bin. */
		remove: (workspaceId: string, sessionId: string): Promise<SessionDeleteResult> =>
			ipcRenderer.invoke("sessions:delete", workspaceId, sessionId),
	},
	updates: {
		status: (): Promise<UpdateStatus> => ipcRenderer.invoke("update:status"),
		/** Restart into the downloaded version. Only offered once it is ready. */
		install: (): void => ipcRenderer.send("update:install"),
		/** Check GitHub right away instead of waiting for the next scheduled check. */
		check: (): void => ipcRenderer.send("update:check"),
		/** Whether a token is saved; the token itself never comes back. */
		hasToken: (): Promise<boolean> => ipcRenderer.invoke("update:has-token"),
		/** Checked against GitHub, then stored encrypted; updates restart with it. */
		setToken: (token: string): Promise<{ ok: true } | { ok: false; message: string }> => ipcRenderer.invoke("update:set-token", token),
		clearToken: (): Promise<void> => ipcRenderer.invoke("update:clear-token"),
		onStatus: (handler: (status: UpdateStatus) => void) => on("update:status", handler),
	},
} as const;

export type TeezApi = typeof teez;

contextBridge.exposeInMainWorld("teez", teez);
