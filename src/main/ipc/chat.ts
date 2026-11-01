import { homedir } from "node:os";
import { statSync } from "node:fs";
import { delimiter } from "node:path";
import { Notification, app, ipcMain, shell, type BrowserWindow } from "electron";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeBinary, type LocateResult } from "../claude/locator.ts";
import { ClaudeSession, type QueryFn } from "../claude/service.ts";
import { ChatRegistry, type AgentKind, type SessionFactory } from "../agents/registry.ts";
import { CLAUDE_PERMISSION_MODES, CODEX_PERMISSION_MODES, type SettingsStore } from "../settings/store.ts";
import { deleteSession, listSessions, readTranscript } from "../sessions/history.ts";
import { AgySession } from "../agy/session.ts";
import { listModels, resolveAgy } from "../agy/locate.ts";
import { CodexSession } from "../codex/session.ts";
import { isSupportedCodex, parseCodexVersion, resolveCodex } from "../codex/locate.ts";
import { codexStatus, probeCodex, readCodexVersion } from "../codex/status.ts";
import { execFileSync } from "node:child_process";
import type { ClaudeUsage } from "../../shared/usage.ts";
import { validateImages } from "../../shared/images.ts";
import { isEffort } from "../../shared/effort.ts";
import { agentDefaults } from "../../shared/agent-defaults.ts";
import { attentionForApproval, attentionForEvent, type Attention, type AttentionContext } from "../agents/attention.ts";
import { UsageProbe } from "../claude/usage-probe.ts";
import { AutoContinue } from "../agents/auto-continue.ts";
import { join } from "node:path";
import type { PresenceTracker } from "../discord/presence.ts";

/** Lets the Discord status follow the chats; `changed` is called when it should be redrawn. */
export type ChatPresence = { readonly tracker: PresenceTracker; readonly changed: () => void };

/**
 * Chats over IPC. The window opens a chat for a workspace and gets an id
 * back; everything after that — messages, approvals, Stop, model switches —
 * is addressed by that id, and every event comes back wrapped with it.
 */

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

let cachedClaude: LocateResult | null = null;
let cachedAgy: string | null | undefined;

/** Antigravity's CLI, or null when it is not installed. */
export function locateAgy(): string | null {
	if (cachedAgy === undefined) {
		cachedAgy = resolveAgy({
			platform: process.platform,
			env: process.env,
			home: homedir(),
			pathEntries: (process.env["PATH"] ?? "").split(delimiter).filter(Boolean),
			isFile,
		});
	}
	return cachedAgy;
}

let cachedCodex: string | null | undefined;
let cachedCodexVersion: string | null | undefined;

/** Codex's native executable, or null when it is not installed. */
export function locateCodex(): string | null {
	if (cachedCodex === undefined) {
		cachedCodex = resolveCodex({
			platform: process.platform,
			env: process.env,
			home: homedir(),
			pathEntries: (process.env["PATH"] ?? "").split(delimiter).filter(Boolean),
			isFile,
		});
	}
	return cachedCodex;
}

/** Codex's version, read once per run (a chat is refused on a protocol TeezOS does not speak). */
function codexVersionOnce(codexPath: string): string | null {
	if (cachedCodexVersion === undefined) {
		try {
			cachedCodexVersion = parseCodexVersion(execFileSync(codexPath, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true }));
		} catch {
			cachedCodexVersion = null;
		}
	}
	return cachedCodexVersion;
}

/** Resolve Claude Code once per run; the answer cannot change mid-session. */
export function locateClaude(): LocateResult {
	cachedClaude ??= resolveClaudeBinary({
		platform: process.platform,
		home: homedir(),
		pathEntries: (process.env["PATH"] ?? "").split(delimiter).filter(Boolean),
		isFile,
	});
	return cachedClaude;
}

const isText = (value: unknown): value is string => typeof value === "string";

/** "busy": the file stayed open (a Claude process still has it) through every retry. */
export type SessionDeleteResult = "deleted" | "missing" | "busy";
const DELETE_ATTEMPTS = 6;
const DELETE_RETRY_MS = 500;

export type ExtraFactories = Partial<Record<AgentKind, SessionFactory>>;

export function registerChatIpc(
	store: SettingsStore,
	getWindow: () => BrowserWindow | null,
	extra: ExtraFactories = {},
	presence?: ChatPresence,
): ChatRegistry {
	const track = (changed: boolean | undefined): void => {
		if (changed) presence?.changed();
	};
	const send = (channel: string, payload: unknown): void => {
		const window = getWindow();
		if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
	};

	const claudeFactory: SessionFactory = (options, callbacks) => {
		const located = locateClaude();
		if (!located.ok) return { error: located.reason, reason: "claude-not-found" };
		return new ClaudeSession({
			// The SDK's own message type is wider than the converter needs; the
			// converter validates every field it reads, so `unknown` is honest.
			query: query as unknown as QueryFn,
			claudePath: located.path,
			cwd: options.cwd,
			model: options.model,
			effort: options.effort,
			permissionMode: options.permission,
			...(options.resume ? { resume: options.resume } : {}),
			onEvent: callbacks.onEvent,
			onApproval: callbacks.onApproval,
		});
	};

	const agyFactory: SessionFactory = (options, callbacks) => {
		const agyPath = locateAgy();
		if (!agyPath) return { error: "Antigravity's CLI (agy) was not found.", reason: "agy-not-found" };
		return new AgySession({
			agyPath,
			cwd: options.cwd,
			model: options.model,
			permission: options.permission,
			effort: options.effort,
			...(options.resume ? { resume: options.resume } : {}),
			onEvent: callbacks.onEvent,
		});
	};

	const codexFactory: SessionFactory = (options, callbacks) => {
		const codexPath = locateCodex();
		if (!codexPath) return { error: "Codex was not found.", reason: "codex-not-found" };
		const version = codexVersionOnce(codexPath);
		if (!version || !isSupportedCodex(version)) return { error: `Codex ${version ?? "(unknown version)"} is not supported.`, reason: "codex-unsupported" };
		return new CodexSession({
			codexPath,
			cwd: options.cwd,
			model: options.model,
			permission: options.permission,
			effort: options.effort,
			...(options.resume ? { resume: options.resume } : {}),
			onEvent: callbacks.onEvent,
			onApproval: callbacks.onApproval,
			clientVersion: app.getVersion(),
		});
	};

	const factories: Partial<Record<AgentKind, SessionFactory>> = { claude: claudeFactory, agy: agyFactory, codex: codexFactory, ...extra };

	const factory: SessionFactory = (options, callbacks) => {
		const chosen = factories[options.agent];
		if (!chosen) {
			return { error: `The ${options.agent} agent is not available.`, reason: "agent-missing" };
		}
		return chosen(options, callbacks);
	};

	const shown = new Set<Notification>();
	/** Only while the window is not being looked at, and only when the setting allows. */
	const notify = (chatId: string, attention: Attention | null): void => {
		const window = getWindow();
		if (!attention || !store.get().agent.notify || !Notification.isSupported()) return;
		if (window && !window.isDestroyed() && window.isFocused() && !window.isMinimized()) return;
		const options = registry.options(chatId);
		const note = new Notification({ title: attention.title, body: attention.body });
		note.on("click", () => {
			const target = getWindow();
			if (!target || target.isDestroyed()) return;
			if (target.isMinimized()) target.restore();
			target.show();
			target.focus();
			if (options) target.webContents.send("chat:focus", { chatId, workspaceId: options.workspaceId });
		});
		// Held until closed: a notification nobody references can be collected, and its click lost.
		shown.add(note);
		note.on("close", () => shown.delete(note));
		note.show();
	};
	const contextOf = (chatId: string): AttentionContext | null => {
		const options = registry.options(chatId);
		if (!options) return null;
		const workspace = store.get().workspaces.find((w) => w.id === options.workspaceId);
		return { agent: options.agent, workspace: workspace?.name ?? "TeezOS" };
	};

	const registry: ChatRegistry = new ChatRegistry(factory, {
		event: (envelope) => {
			send("chat:event", envelope);
			track(presence?.tracker.event(envelope.chatId, envelope.event));
			const context = contextOf(envelope.chatId);
			if (context) notify(envelope.chatId, attentionForEvent(envelope.event, context));
			// Only Claude reports a limit reset time; Antigravity chats are not resumed.
			if (context?.agent === "claude") autoContinue.event(envelope.chatId, envelope.event);
		},
		approval: (envelope) => {
			send("chat:approval", envelope);
			track(presence?.tracker.waiting(envelope.chatId));
			const context = contextOf(envelope.chatId);
			if (context) notify(envelope.chatId, attentionForApproval(envelope.request, context));
		},
	});

	// Carries a Claude chat on by itself once the plan limit resets. Timers die with the chat or the app.
	const autoContinue: AutoContinue = new AutoContinue({
		now: () => Date.now(),
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		send: (chatId, text) => {
			const context = contextOf(chatId);
			if (context) track(presence?.tracker.sent(chatId, context.agent, context.workspace));
			return registry.send(chatId, text);
		},
		enabled: () => store.get().modules.chat.autoContinue,
		onChange: (change) => send("chat:pause", change),
	});
	registry.onClose((chatId) => autoContinue.close(chatId));
	app.on("will-quit", () => autoContinue.disposeAll());
	store.onChange(() => autoContinue.settingsChanged());
	ipcMain.on("chat:cancel-pause", (_event, chatId: unknown) => {
		if (isText(chatId)) autoContinue.cancel(chatId);
	});

	ipcMain.handle("agents:codex-status", () => codexStatus({ locate: locateCodex, version: readCodexVersion, probe: (codexPath) => probeCodex(codexPath) }));

	ipcMain.handle("agents:agy-status", async () => {
		const agyPath = locateAgy();
		if (!agyPath) return { available: false, models: [] };
		return { available: true, models: await listModels(agyPath) };
	});

	// Claude's plan limits for the rails beside the composer; null hides them.
	// With no live session to ask (app start, a fresh chat), a probe asks instead: it sends no message.
	let probe: UsageProbe | null = null;
	const probeUsage = (): Promise<ClaudeUsage | null> => {
		const located = locateClaude();
		if (!located.ok) return Promise.resolve(null);
		probe ??= new UsageProbe({ query: query as unknown as QueryFn, claudePath: located.path, cwd: homedir(), now: () => Date.now() });
		return probe.get();
	};
	app.on("will-quit", () => probe?.dispose());
	ipcMain.handle("usage:get", async () => (await registry.usage()) ?? (await probeUsage()));

	ipcMain.handle("claude:status", () => {
		const located = locateClaude();
		return located.ok
			? { ok: true as const, path: located.path }
			: { ok: false as const, reason: located.reason };
	});

	const projectsRoot = join(homedir(), ".claude", "projects");

	ipcMain.handle("sessions:list", (_event, workspaceId: unknown) => {
		const workspace = store.get().workspaces.find((w) => w.id === workspaceId);
		return workspace ? listSessions(projectsRoot, workspace.path) : [];
	});

	ipcMain.handle("sessions:transcript", (_event, workspaceId: unknown, sessionId: unknown) => {
		const workspace = store.get().workspaces.find((w) => w.id === workspaceId);
		if (!workspace || !isText(sessionId)) return [];
		return readTranscript(projectsRoot, workspace.path, sessionId);
	});

	// To the Recycle Bin, never unlinked: a session deleted by mistake can be restored.
	// A chat tab closed just before still has its Claude process letting go of
	// the file (Windows refuses to move an open file), so a refusal is retried.
	ipcMain.handle("sessions:delete", async (_event, workspaceId: unknown, sessionId: unknown): Promise<SessionDeleteResult> => {
		const workspace = store.get().workspaces.find((w) => w.id === workspaceId);
		if (!workspace || !isText(sessionId)) return "missing";
		for (let attempt = 1; ; attempt += 1) {
			try {
				return (await deleteSession(projectsRoot, workspace.path, sessionId, (path) => shell.trashItem(path))) ? "deleted" : "missing";
			} catch {
				if (attempt >= DELETE_ATTEMPTS) return "busy";
				await new Promise((resolve) => setTimeout(resolve, DELETE_RETRY_MS));
			}
		}
	});

	ipcMain.handle("chat:create", (_event, request: unknown) => {
		if (typeof request !== "object" || request === null) return null;
		const r = request as Record<string, unknown>;
		const workspace = store.get().workspaces.find((w) => w.id === r["workspaceId"]);
		if (!workspace) return null;

		const defaults = store.get().agent;
		const PERMISSIONS: Readonly<Record<AgentKind, readonly string[]>> = {
			claude: CLAUDE_PERMISSION_MODES,
			agy: ["ask", "plan", "accept-edits", "full-auto"],
			codex: CODEX_PERMISSION_MODES,
		};
		const MODEL = /^[\w.:-]{0,80}$/;
		const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		const agent: AgentKind = r["agent"] === "agy" || r["agent"] === "claude" || r["agent"] === "codex" ? r["agent"] : defaults.defaultAgent;
		const fallback = agentDefaults(agent, defaults);
		const model = isText(r["model"]) && MODEL.test(r["model"]) ? r["model"] : fallback.model;
		const permission = isText(r["permission"]) && PERMISSIONS[agent].includes(r["permission"]) ? r["permission"] : fallback.permission;
		const effort = isEffort(agent, r["effort"]) ? r["effort"] : fallback.effort;

		return registry.create({
			workspaceId: workspace.id,
			cwd: workspace.path,
			agent,
			model,
			permission,
			effort,
			...(isText(r["resume"]) && SESSION.test(r["resume"]) ? { resume: r["resume"] } : {}),
		});
	});

	ipcMain.on("chat:send", (_event, chatId: unknown, text: unknown, images: unknown) => {
		if (!isText(chatId) || !isText(text)) return;
		const pictures = validateImages(images);
		if (pictures === null) {
			// "bad-image" refuses this one message; a turn already running carries on.
			send("chat:event", { chatId, event: { kind: "run-error", sessionId: "", reason: "bad-image", message: "Images must be PNG, JPEG, GIF or WebP, at most 5 of them and under 5 MB each once encoded." } });
			return;
		}
		if (!text.trim() && pictures.length === 0) return;
		// Tracked before sending: an agent that fails to start reports run-error
		// synchronously, inside send, and that must find the chat to clear it.
		const context = contextOf(chatId);
		if (context) track(presence?.tracker.sent(chatId, context.agent, context.workspace));
		autoContinue.userSent(chatId);
		if (registry.send(chatId, text.trim(), pictures)) return;
		track(presence?.tracker.closed(chatId));
		// The window thinks this chat is alive; say otherwise, or it waits forever.
		send("chat:event", {
			chatId,
			event: { kind: "run-error", sessionId: "", reason: "chat-closed", message: "This chat is no longer running. Start a new one with +." },
		});
	});

	ipcMain.on("chat:approve", (_event, chatId: unknown, id: unknown, decision: unknown) => {
		if (!isText(chatId) || !isText(id)) return;
		if (decision !== "allow" && decision !== "deny") return;
		registry.approve(chatId, id, decision);
		track(presence?.tracker.approved(chatId));
	});

	ipcMain.on("chat:stop", (_event, chatId: unknown) => {
		if (isText(chatId)) void registry.stop(chatId);
	});

	ipcMain.on("chat:close", (_event, chatId: unknown) => {
		if (!isText(chatId)) return;
		registry.close(chatId);
		track(presence?.tracker.closed(chatId));
	});

	ipcMain.handle("chat:set-model", (_event, chatId: unknown, model: unknown) => {
		if (isText(chatId) && isText(model) && /^[\w.:-]{0,80}$/.test(model)) return registry.setModel(chatId, model);
		return undefined;
	});

	// Checked against the chat's own agent: Antigravity has no "max", Claude no bare "".
	ipcMain.handle("chat:set-effort", (_event, chatId: unknown, effort: unknown) => {
		if (!isText(chatId)) return;
		const agent = registry.options(chatId)?.agent;
		if (agent && isEffort(agent, effort)) return registry.setEffort(chatId, effort);
	});

	ipcMain.handle("chat:set-permission", (_event, chatId: unknown, mode: unknown) => {
		if (isText(chatId) && isText(mode)) return registry.setPermissionMode(chatId, mode);
		return undefined;
	});

	ipcMain.handle("chat:commands", (_event, chatId: unknown) => {
		if (!isText(chatId) || chatId.length > 64) return [];
		return registry.commands(chatId);
	});

	return registry;
}
