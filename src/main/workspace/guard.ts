import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * The one door between a renderer request and the disk.
 *
 * Paths cross the bridge relative to a workspace root, with forward slashes,
 * "" meaning the root. Anything that could name a location outside that root
 * is refused before it is joined, rather than joined and then checked: on
 * Windows there are too many spellings of "elsewhere" (other drives, UNC
 * shares, `\\?\`, drive-relative `C:foo`, NTFS streams, 8.3 short names) for
 * a prefix check alone to be trusted.
 */

export type GuardResult =
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly reason: string };

type PathApi = typeof path.win32 | typeof path.posix;

const isWindows = (api: PathApi): boolean => api.sep === "\\";

function refuse(reason: string): GuardResult {
	return { ok: false, reason };
}

export function resolveInside(
	root: string,
	relative: string,
	api: PathApi = path,
): GuardResult {
	if (typeof relative !== "string") return refuse("The path is not text.");
	if (relative.includes("\0")) return refuse("The path contains a NUL byte.");

	const windows = isWindows(api);
	const segments = relative.split(/[\\/]+/).filter((segment) => segment.length > 0);

	if (windows) {
		// `C:foo`, `C:\x`, `\\server`, `\\?\` and `\x` all leave the folder.
		if (/^[a-zA-Z]:/.test(relative)) return refuse("Drive paths are not allowed.");
		if (/^[\\/]/.test(relative)) return refuse("Rooted paths are not allowed.");
		for (const segment of segments) {
			// `file:stream` reads an NTFS alternate data stream.
			if (segment.includes(":")) return refuse("Colons are not allowed in a path.");
			// `PROGRA~1` is a short name for some other, longer folder.
			if (/~\d/.test(segment)) return refuse("Short (8.3) names are not allowed.");
		}
	} else if (relative.startsWith("/")) {
		return refuse("Absolute paths are not allowed.");
	}

	if (segments.some((segment) => segment === "..")) {
		return refuse("Parent folders (..) are not allowed.");
	}

	const joined = segments.length === 0 ? api.normalize(root) : api.join(root, ...segments);
	const back = api.relative(api.normalize(root), joined);
	if (back.startsWith("..") || api.isAbsolute(back)) {
		return refuse("The path leaves the workspace.");
	}
	return { ok: true, path: joined };
}

/**
 * The bridge-facing name of an absolute path, or null when it is not inside
 * the root. Windows compares case-insensitively, as the file system does.
 */
export function toRelative(root: string, absolute: string, api: PathApi = path): string | null {
	const windows = isWindows(api);
	const norm = (value: string): string => {
		const normal = api.normalize(value);
		return windows ? normal.toLowerCase() : normal;
	};
	const rel = api.relative(norm(root), norm(absolute));
	if (rel.startsWith("..") || api.isAbsolute(rel)) return null;
	if (rel === "") return "";
	// Re-derive from the original so the file's own capitals survive.
	const normalAbsolute = api.normalize(absolute);
	const original = normalAbsolute.slice(normalAbsolute.length - rel.length);
	return original.split(api.sep).join("/");
}

/**
 * The lexical check above cannot see symlinks and junctions. For a path that
 * exists, the real location must also be inside the real root.
 */
export function resolveInsideReal(root: string, relative: string): GuardResult {
	const lexical = resolveInside(root, relative);
	if (!lexical.ok) return lexical;

	let realRoot: string;
	try {
		realRoot = realpathSync.native(root);
	} catch {
		return refuse("The workspace folder no longer exists.");
	}

	let realTarget: string;
	try {
		realTarget = realpathSync.native(lexical.path);
	} catch {
		// Not there yet (a file about to be written): the lexical answer holds,
		// but its parent must still resolve inside.
		const parent = path.dirname(lexical.path);
		try {
			realTarget = path.join(realpathSync.native(parent), path.basename(lexical.path));
		} catch {
			return refuse("The folder does not exist.");
		}
	}

	if (toRelative(realRoot, realTarget) === null) {
		return refuse("The path leads outside the workspace through a link.");
	}
	return lexical;
}
