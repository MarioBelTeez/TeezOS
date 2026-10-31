import { join } from "node:path";
import { readFileSync } from "node:fs";
import { app, powerMonitor } from "electron";
import electronUpdater from "electron-updater";
import {
	resolveUpdateConfig,
	TOKEN_FILE_NAME,
	type UpdateConfig,
} from "./update-config.ts";
import { explainUpdateError, retryDelayMs } from "./update-error.ts";

/**
 * Keep the installed app current without anyone remembering to.
 *
 * electron-updater reads the releases published by `npm run release` and
 * swaps the app on the next restart. Everything credential-shaped lives in
 * update-config.ts; this file only wires that decision to the library and
 * reports what is happening.
 *
 * Failure here is never fatal: no token, no network, a rate-limited GitHub —
 * each ends as a status the window can show, and the app carries on.
 */

export type UpdateStatus =
	| { readonly state: "disabled"; readonly reason: string }
	| { readonly state: "checking" }
	| { readonly state: "current"; readonly version: string }
	| { readonly state: "available"; readonly version: string }
	| { readonly state: "downloading"; readonly percent: number }
	| { readonly state: "ready"; readonly version: string }
	| { readonly state: "failed"; readonly message: string; readonly retryAt?: number };

/** Re-check this often, so a machine left running still catches releases. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** After waking from sleep, give the network a moment before checking. */
const AFTER_RESUME_MS = 15_000;

/** Set while updates run: checks right away (the Updates page's "Check now"). */
let checkNow: (() => void) | null = null;

export function checkForUpdatesNow(): void {
	checkNow?.();
}

function readTokenFile(): string | null {
	try {
		return readFileSync(join(app.getPath("userData"), TOKEN_FILE_NAME), "utf-8");
	} catch {
		return null;
	}
}

export function currentUpdateConfig(readStoredToken: () => string | null): UpdateConfig {
	return resolveUpdateConfig({
		isPackaged: app.isPackaged,
		env: process.env,
		readTokenFile,
		readStoredToken,
	});
}

/** Start checking; the returned function stops, so a newly saved token can restart it. */
export function startUpdates(report: (status: UpdateStatus) => void, readStoredToken: () => string | null): () => void {
	const config = currentUpdateConfig(readStoredToken);
	if (!config.enabled) {
		report({ state: "disabled", reason: config.reason });
		return () => undefined;
	}

	const { autoUpdater } = electronUpdater;
	// The token goes straight to the library. It used to be set as GH_TOKEN in
	// process.env, which every terminal, git call and agent then inherited —
	// one `printenv` away from anyone at the keyboard or any agent.
	autoUpdater.setFeedURL({ provider: "github", owner: "MarioBelTeez", repo: "TeezAI", private: true, token: config.token });

	// Download when one is found, but never restart under the user: a session
	// mid-turn should not vanish because a release landed.
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;

	const onChecking = (): void => report({ state: "checking" });
	const onCurrent = (info: { version: string }): void => {
		succeeded();
		report({ state: "current", version: String(info.version) });
	};
	const onAvailable = (info: { version: string }): void => {
		succeeded();
		report({ state: "available", version: String(info.version) });
	};
	const onProgress = (progress: { percent: number }): void => report({ state: "downloading", percent: Math.round(progress.percent) });
	const onReady = (info: { version: string }): void => report({ state: "ready", version: String(info.version) });
	// A failed check caused by sleep or a dropped connection is tried again
	// soon (1, 2, 4 … minutes) instead of waiting six hours; anything else waits.
	let retryTimer: NodeJS.Timeout | null = null;
	let attempts = 0;
	const fail = (raw: string): void => {
		const { message, retryable } = explainUpdateError(raw);
		if (!retryable) {
			report({ state: "failed", message });
			return;
		}
		if (!retryTimer) {
			const delay = retryDelayMs(attempts);
			attempts += 1;
			retryTimer = setTimeout(() => {
				retryTimer = null;
				check();
			}, delay);
			report({ state: "failed", message, retryAt: Date.now() + delay });
		}
	};
	const succeeded = (): void => {
		attempts = 0;
	};
	const onError = (error: Error): void => fail(error.message);
	autoUpdater.on("checking-for-update", onChecking);
	autoUpdater.on("update-not-available", onCurrent);
	autoUpdater.on("update-available", onAvailable);
	autoUpdater.on("download-progress", onProgress);
	autoUpdater.on("update-downloaded", onReady);
	autoUpdater.on("error", onError);

	const check = (): void => {
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		void autoUpdater.checkForUpdates().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
	};

	check();
	const timer = setInterval(check, CHECK_INTERVAL_MS);
	let resumeTimer: NodeJS.Timeout | null = null;
	const onResume = (): void => {
		if (resumeTimer) clearTimeout(resumeTimer);
		resumeTimer = setTimeout(check, AFTER_RESUME_MS);
	};
	powerMonitor.on("resume", onResume);
	checkNow = check;
	return () => {
		clearInterval(timer);
		if (retryTimer) clearTimeout(retryTimer);
		if (resumeTimer) clearTimeout(resumeTimer);
		powerMonitor.off("resume", onResume);
		if (checkNow === check) checkNow = null;
		autoUpdater.off("checking-for-update", onChecking);
		autoUpdater.off("update-not-available", onCurrent);
		autoUpdater.off("update-available", onAvailable);
		autoUpdater.off("download-progress", onProgress);
		autoUpdater.off("update-downloaded", onReady);
		autoUpdater.off("error", onError);
	};
}

/** Restart into the downloaded version, when the user says so. */
export function installUpdateNow(): void {
	electronUpdater.autoUpdater.quitAndInstall();
}
