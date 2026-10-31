import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { QueryFn } from "../../../src/main/claude/service.ts";
import { createEngineService } from "../../../src/main/feed/engines/service.ts";
import { jobFolders, liveReadSource } from "../../../src/main/feed/live.ts";
import { DEFAULT_FEED_PREFS } from "../../../src/shared/feed-engine.ts";
import type { PhoneConfig } from "./config.ts";
import type { GitSync } from "./git-sync.ts";
import { feedRoute } from "./routes/feed.ts";
import type { Route } from "./http.ts";

const KEYS_FILE = "keys.json";
const NO_KEY = "No Gemini or Groq key is saved on the server (keys.json). The phone cannot use Claude for Feed.";

/** A key from `<secretsDir>/keys.json`, read when asked so a new key works without a restart. Never logged. */
function keyFrom(secretsDir: string, name: "gemini" | "groq"): string | null {
	const file = path.join(secretsDir, KEYS_FILE);
	if (!existsSync(file)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		const value = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)[name] : undefined;
		return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
	} catch {
		return null;
	}
}

/** The Feed route as the server runs it: Gemini or Groq from keys.json, the desktop's real reader, no Claude engine. */
export function createFeedRoute(config: PhoneConfig, sync: GitSync): Route {
	const geminiKey = (): string | null => keyFrom(config.secretsDir, "gemini");
	const groqKey = (): string | null => keyFrom(config.secretsDir, "groq");
	const engines = createEngineService({
		fetch: (url, init) => fetch(url, init),
		// The Claude engine needs the desktop's Claude Code locator; the phone offers Gemini and Groq only.
		query: (() => {
			throw new Error(NO_KEY);
		}) as unknown as QueryFn,
		claudePath: () => null,
		geminiKey,
		groqKey,
		prefs: () => DEFAULT_FEED_PREFS,
		now: Date.now,
	});
	const folders = jobFolders(tmpdir());
	folders.sweep();
	return feedRoute({
		vault: config.vaultDir,
		dataDir: config.dataDir,
		sync,
		// TEEZ_PHONE_WATCH: the installed watch.py (no Claude plugin cache on the server).
		readSource: liveReadSource(config.watchScript ? { watchScript: config.watchScript } : {}),
		workDir: folders,
		groqKey,
		now: Date.now,
		complete: async (item, source, titles, workDir, signal) => {
			// With neither key the desktop falls back to Claude; here that means no key.
			if (engines.status().engine === "claude") return { ok: false, kind: "auth", error: NO_KEY, engine: "claude" };
			return engines.complete(item, source, titles, workDir, signal);
		},
	});
}
