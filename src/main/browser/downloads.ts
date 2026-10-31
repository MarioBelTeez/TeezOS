import { join } from "node:path";

/**
 * Where a download lands. The file name comes from the server, so it is cut
 * down to a bare name Windows accepts (no folders, no "..", no reserved
 * device names), and a name already taken gets " (1)", " (2)"… like a browser.
 */

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_NAME = 200;

export function safeFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	let clean = "";
	for (const char of base) {
		const code = char.charCodeAt(0);
		clean += code < 32 || '<>:"|?*'.includes(char) ? "_" : char;
	}
	// Windows drops trailing dots and spaces itself; a name of only those is no name.
	clean = clean.replace(/[. ]+$/, "").trim();
	if (clean === "" || /^\.+$/.test(clean)) return "download";
	if (RESERVED.test(clean)) clean = `_${clean}`;
	return clean.length > MAX_NAME ? clean.slice(clean.length - MAX_NAME) : clean;
}

export function uniquePath(dir: string, name: string, exists: (path: string) => boolean): string {
	const safe = safeFileName(name);
	const first = join(dir, safe);
	if (!exists(first)) return first;
	const dot = safe.lastIndexOf(".");
	const stem = dot > 0 ? safe.slice(0, dot) : safe;
	const ext = dot > 0 ? safe.slice(dot) : "";
	for (let n = 1; n < 10_000; n += 1) {
		const candidate = join(dir, `${stem} (${n})${ext}`);
		if (!exists(candidate)) return candidate;
	}
	return join(dir, `${stem} (${Date.now()})${ext}`);
}

/**
 * Types Explorer reads, or runs, without a double-click: a .library-ms,
 * .searchConnector-ms, .url or .scf sitting in Downloads can point Windows
 * at a remote share the moment the folder is viewed (the same NTLM-hash leak
 * net-guard.ts stops), and .lnk/.hta and theme files run or fetch on open.
 * A page never gets to save one.
 */
const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
	".library-ms",
	".searchconnector-ms",
	".search-ms",
	".url",
	".website",
	".scf",
	".lnk",
	".hta",
	".settingcontent-ms",
	".desktop",
	".theme",
	".themepack",
]);

/** Whether a download would be saved as one of those types (checked on the name it would really get). */
export function isBlockedDownload(name: string): boolean {
	const safe = safeFileName(name).toLowerCase();
	// dot >= 0: a bare ".url" (no stem) is still a URL file to Explorer.
	const dot = safe.lastIndexOf(".");
	return dot >= 0 && BLOCKED_EXTENSIONS.has(safe.slice(dot));
}

/** Download questions that may wait at once in one tab; a page cannot pile them up. */
export const MAX_PENDING_DOWNLOADS = 3;
/** An unanswered download question is a "no" after this long. */
export const DOWNLOAD_CONFIRM_MS = 60_000;

export type DownloadGate = { readonly action: "ask" } | { readonly action: "refuse"; readonly reason: string };

/** What happens to a download a page starts: refused outright, or asked about in the panel (nothing is saved before a yes). */
export function downloadGate(name: string, pendingInTab: number): DownloadGate {
	if (isBlockedDownload(name)) {
		return { action: "refuse", reason: "this file type can make Windows contact other computers when the folder is opened, so it is never saved" };
	}
	if (pendingInTab >= MAX_PENDING_DOWNLOADS) return { action: "refuse", reason: `${MAX_PENDING_DOWNLOADS} downloads are already waiting for an answer in this tab` };
	return { action: "ask" };
}

/**
 * The Mark-of-the-Web written to a saved file's Zone.Identifier stream:
 * internet zone, and the address it came from (without credentials), so
 * Windows SmartScreen and Office treat it as downloaded. Anything that is not
 * an http(s) address (blob:, data:) is recorded as about:internet, as Chrome does.
 */
export function zoneIdentifier(url: string): string {
	let host = "about:internet";
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			parsed.username = "";
			parsed.password = "";
			host = parsed.href.replace(/[\r\n]/g, "");
		}
	} catch {
		// Not an address: about:internet.
	}
	return `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${host}\r\n`;
}

/** A size for the confirm bar. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "unknown size";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}
