import { join } from "node:path";

/**
 * Where settings, secrets and the update token live. Electron derives the
 * folder from the product name, and the app was called TeezAI before 0.3.8
 * (TeezOS since): pinning it keeps every install on the folder it already
 * has. On Windows the two spellings Electron used ("TeezAI" packaged,
 * "teezai" in dev) are the same folder anyway.
 */

const LEGACY_NAMES = ["TeezAI", "teezai"] as const;

export function dataDirFor(appData: string, exists: (path: string) => boolean): string {
	for (const name of LEGACY_NAMES) {
		const path = join(appData, name);
		if (exists(path)) return path;
	}
	return join(appData, LEGACY_NAMES[0]);
}

/** The start-at-login entry the old name left behind (Electron names it "electron.app.<name>"). */
export const LEGACY_LOGIN_ITEM = "electron.app.TeezAI";
