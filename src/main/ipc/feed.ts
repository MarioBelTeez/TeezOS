import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ipcMain, type BrowserWindow } from "electron";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../claude/service.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { SecretStore } from "../settings/secrets.ts";
import { FeedRunner } from "../feed/runner.ts";
import { commitFeedNotes } from "../feed/commit.ts";
import { DIGEST, discardDraft, installSkill, isSkillName, previewDraft, type DraftPreview, type SkillResult } from "../feed/skills.ts";
import { jobFolders, liveReadSource } from "../feed/live.ts";
import { createEngineService, defaultModel } from "../feed/engines/service.ts";
import { findFiledSource, scanSourceNotes } from "../feed/history.ts";
import { listConceptTitles, writeNotes } from "../feed/writer.ts";
import { locateClaude } from "./chat.ts";
import { pushPhoneKeys } from "../phone/push-keys.ts";
import { isFeedId, isFeedKind, isGroqKey, MAX_FEED_NOTE, MAX_FEED_SOURCE, normalizeFeed, type FeedItem } from "../../shared/feed.ts";
import {
	ENGINE_IDS,
	isGeminiKey,
	normalizePrefs,
	type EngineId,
	type EngineStatus,
	type FeedPrefs,
	type ModelInfo,
} from "../../shared/feed-engine.ts";
import type { VaultSource } from "../../shared/feed-history.ts";

/**
 * Feed the Brain over IPC. The window is untrusted: every argument is checked
 * here (types, lengths, id and skill-name formats) before the runner or the
 * disk sees it. The Gemini and Groq keys go in and never come back out — the
 * window only learns whether one is saved. A finished job commits and pushes
 * exactly the notes it wrote (feed/commit.ts); the window has no commit step.
 */

/** Writes of the queue file are coalesced; a busy job logs many lines a second. */
const SAVE_DELAY_MS = 400;

function readJson(file: string): unknown {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function writeJson(file: string, value: unknown, what: string): void {
	try {
		const temp = `${file}.tmp`;
		writeFileSync(temp, JSON.stringify(value), "utf8");
		renameSync(temp, file);
	} catch (error) {
		console.error(`[feed] could not save ${what}:`, error);
	}
}

const CHANNELS = [
	"feed:list",
	"feed:add",
	"feed:retry",
	"feed:cancel",
	"feed:remove",
	"feed:preview-skill",
	"feed:install-skill",
	"feed:discard-skill",
	"feed:has-groq",
	"feed:set-groq",
	"feed:has-gemini",
	"feed:set-gemini",
	"feed:prefs",
	"feed:set-prefs",
	"feed:engine-status",
	"feed:models",
	"feed:history",
	"phone:send-keys",
] as const;

export type ModelChoices =
	| { readonly ok: true; readonly models: readonly ModelInfo[]; readonly defaultModel: string | null }
	| { readonly ok: false; readonly error: string };

type KeyResult = { ok: true } | { ok: false; message: string };

export function registerFeedIpc(
	store: SettingsStore,
	secrets: SecretStore,
	getWindow: () => BrowserWindow | null,
	file: string,
	prefsFile: string,
): () => void {
	let pending: FeedItem[] | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const flush = (): void => {
		if (timer) clearTimeout(timer);
		timer = null;
		if (pending) writeJson(file, pending, "the queue");
		pending = null;
	};
	const save = (items: FeedItem[]): void => {
		pending = items;
		timer ??= setTimeout(flush, SAVE_DELAY_MS);
	};

	let prefs: FeedPrefs = normalizePrefs(readJson(prefsFile));

	// Job folders live in the system temp folder; any left by a run TeezAI quit during go now.
	const folders = jobFolders(tmpdir());
	folders.sweep();

	const engines = createEngineService({
		fetch: (url, init) => fetch(url, init),
		query: query as unknown as QueryFn,
		claudePath: () => {
			const located = locateClaude();
			return located.ok ? located.path : null;
		},
		geminiKey: () => secrets.get("gemini"),
		groqKey: () => secrets.get("groq"),
		prefs: () => prefs,
		now: Date.now,
	});

	const runner = new FeedRunner({
		vault: () => store.get().vaultPath,
		groqKey: () => secrets.get("groq"),
		readSource: liveReadSource(),
		workDir: folders,
		filed: (vault, item) => findFiledSource(vault, item.source),
		conceptTitles: listConceptTitles,
		complete: engines.complete,
		write: writeNotes,
		commit: (vault, paths, message) => commitFeedNotes(vault, paths, message),
		save,
		emit: (items) => {
			const window = getWindow();
			if (window && !window.isDestroyed()) window.webContents.send("feed:changed", items);
		},
		now: Date.now,
		// The Feed module off: nothing starts; turning it off cancels the running job (below).
		paused: () => !store.get().modules.feed.enabled,
	});
	runner.load(normalizeFeed(readJson(file)));
	let feedOn = store.get().modules.feed.enabled;
	const offModule = store.onChange((settings) => {
		const on = settings.modules.feed.enabled;
		if (on === feedOn) return;
		feedOn = on;
		if (on) runner.resume();
		else runner.pause();
	});

	ipcMain.handle("feed:list", () => runner.items());

	ipcMain.handle("feed:add", (_event, source: unknown, kind: unknown, note: unknown) => {
		if (typeof source !== "string" || source.length === 0 || source.length > MAX_FEED_SOURCE) return { error: "Paste a link or drop a file." };
		if (!isFeedKind(kind)) return { error: "Unknown kind." };
		if (typeof note !== "string" || note.length > MAX_FEED_NOTE) return { error: `The note is longer than ${MAX_FEED_NOTE} characters.` };
		return runner.add(source, kind, note);
	});

	ipcMain.handle("feed:retry", (_event, id: unknown) => {
		if (isFeedId(id)) runner.retry(id);
	});
	ipcMain.handle("feed:cancel", (_event, id: unknown) => {
		if (isFeedId(id)) runner.cancel(id);
	});
	ipcMain.handle("feed:remove", (_event, id: unknown) => {
		if (isFeedId(id)) runner.remove(id);
	});

	const skillAction =
		<T>(action: (vault: string, name: string) => Promise<T | { ok: false; reason: string }>) =>
		async (_event: unknown, name: unknown): Promise<T | { ok: false; reason: string }> => {
			if (typeof name !== "string" || !isSkillName(name)) return { ok: false, reason: "That is not a valid skill name." };
			const vault = store.get().vaultPath;
			if (!vault) return { ok: false, reason: "No vault is set." };
			return action(vault, name);
		};
	ipcMain.handle("feed:preview-skill", skillAction<DraftPreview>(previewDraft));
	// Only after the window showed the preview: the digest pins the version the user confirmed.
	ipcMain.handle("feed:install-skill", async (event, name: unknown, digest: unknown): Promise<SkillResult> => {
		if (typeof digest !== "string" || !DIGEST.test(digest)) return { ok: false, reason: "Review the draft before installing it." };
		return skillAction<SkillResult>((vault, valid) => installSkill(vault, valid, digest))(event, name);
	});
	ipcMain.handle("feed:discard-skill", skillAction<SkillResult>(discardDraft));

	const setKey = (name: "groq" | "gemini", valid: (value: unknown) => boolean, hint: string) => (_event: unknown, key: unknown): KeyResult => {
		const value = typeof key === "string" ? key.trim() : "";
		if (!valid(value)) return { ok: false, message: hint };
		try {
			secrets.set(name, value);
			engines.forget(name);
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	};
	ipcMain.handle("feed:has-groq", () => secrets.has("groq"));
	ipcMain.handle("feed:set-groq", setKey("groq", isGroqKey, "A Groq key starts with gsk_ and has no spaces."));
	ipcMain.handle("feed:has-gemini", () => secrets.has("gemini"));
	ipcMain.handle("feed:set-gemini", setKey("gemini", isGeminiKey, "That does not look like a Gemini key from aistudio.google.com (no spaces, 20 to 200 characters)."));

	ipcMain.handle("feed:prefs", (): FeedPrefs => prefs);
	ipcMain.handle("feed:set-prefs", (_event, raw: unknown): FeedPrefs => {
		prefs = normalizePrefs(raw);
		writeJson(prefsFile, prefs, "the engine choice");
		return prefs;
	});
	ipcMain.handle("feed:engine-status", (): EngineStatus => engines.status());
	ipcMain.handle("feed:models", async (_event, engine: unknown): Promise<ModelChoices> => {
		if (typeof engine !== "string" || !(ENGINE_IDS as readonly string[]).includes(engine)) return { ok: false, error: "Unknown engine." };
		const id = engine as EngineId;
		const list = await engines.models(id);
		return list.ok ? { ok: true, models: list.models, defaultModel: defaultModel(id, list.models) } : { ok: false, error: list.error };
	});
	ipcMain.handle("feed:history", async (): Promise<VaultSource[]> => {
		const vault = store.get().vaultPath;
		return vault ? scanSourceNotes(vault) : [];
	});

	// The keys are read here and go straight to ssh's stdin; the window only gets the outcome.
	ipcMain.handle("phone:send-keys", () => pushPhoneKeys({ gemini: secrets.get("gemini"), groq: secrets.get("groq") }));

	return () => {
		offModule();
		runner.stop();
		flush();
		for (const channel of CHANNELS) ipcMain.removeHandler(channel);
	};
}
