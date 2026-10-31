import { readdir, readFile, stat, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { resolveInsideReal } from "./guard.ts";

/**
 * Reading and writing inside a workspace. Every path is checked by the guard
 * first — lexically, then against the real location so a junction cannot
 * lead out — and every failure comes back as a reason, never a throw, since
 * a throw across IPC arrives in the renderer as an unreadable stack.
 */

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Never shown: git's internals are not something to browse or edit. */
const HIDDEN = new Set([".git"]);

/** Shown, but dimmed and never expanded on their own: build output and deps. */
const HEAVY = new Set([
	"node_modules",
	"dist",
	"out",
	"release",
	".next",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
	"target",
	".turbo",
	".cache",
]);

const IMAGE_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".bmp": "image/bmp",
	".avif": "image/avif",
};

export type DirEntry = {
	readonly name: string;
	/** Workspace-relative, forward slashes. */
	readonly path: string;
	readonly kind: "dir" | "file";
	readonly heavy: boolean;
};

export type Failure = { readonly ok: false; readonly reason: string };

export type ListResult = { readonly ok: true; readonly entries: readonly DirEntry[] } | Failure;

export type FileContent =
	| {
			readonly ok: true;
			readonly kind: "text";
			readonly content: string;
			readonly size: number;
			/** Not valid UTF-8: shown, but saving would corrupt it, so read-only. */
			readonly readOnly?: boolean;
	  }
	| { readonly ok: true; readonly kind: "image"; readonly dataUrl: string; readonly size: number }
	| { readonly ok: true; readonly kind: "binary"; readonly size: number }
	| { readonly ok: true; readonly kind: "too-large"; readonly size: number }
	| Failure;

export type WriteResult = { readonly ok: true } | Failure;

const fail = (reason: string): Failure => ({ ok: false, reason });

/** `.git` holds config and hooks git executes; it is never opened through the bridge. */
function insideGitDir(relative: string): boolean {
	return relative.split(/[\\/]+/).some((segment) => segment.toLowerCase() === ".git");
}

function guard(root: string, relative: string): ReturnType<typeof resolveInsideReal> {
	if (insideGitDir(relative)) return { ok: false, reason: "Files inside .git are off limits." };
	return resolveInsideReal(root, relative);
}

function joinRelative(parent: string, name: string): string {
	return parent ? `${parent}/${name}` : name;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function listDirectory(root: string, relative: string): Promise<ListResult> {
	const guarded = guard(root, relative);
	if (!guarded.ok) return guarded;

	try {
		const dirents = await readdir(guarded.path, { withFileTypes: true });
		const entries: DirEntry[] = [];
		for (const dirent of dirents) {
			if (HIDDEN.has(dirent.name)) continue;
			let isDir = dirent.isDirectory();
			if (dirent.isSymbolicLink()) {
				// Follow the link only to decide how to draw it; opening it
				// goes back through the guard, which checks where it leads.
				try {
					isDir = (await stat(path.join(guarded.path, dirent.name))).isDirectory();
				} catch {
					continue; // a dangling link
				}
			}
			entries.push({
				name: dirent.name,
				path: joinRelative(relative.replace(/\\/g, "/").replace(/\/+$/, ""), dirent.name),
				kind: isDir ? "dir" : "file",
				heavy: isDir && HEAVY.has(dirent.name),
			});
		}
		entries.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
			const left = a.name.toLowerCase();
			const right = b.name.toLowerCase();
			return left < right ? -1 : left > right ? 1 : 0;
		});
		return { ok: true, entries };
	} catch (error) {
		return fail(message(error));
	}
}

export async function readWorkspaceFile(root: string, relative: string): Promise<FileContent> {
	const guarded = guard(root, relative);
	if (!guarded.ok) return guarded;

	try {
		const info = await stat(guarded.path);
		if (!info.isFile()) return fail("Not a file.");

		const mime = IMAGE_TYPES[path.extname(guarded.path).toLowerCase()];
		if (mime) {
			if (info.size > MAX_IMAGE_BYTES) return { ok: true, kind: "too-large", size: info.size };
			const data = await readFile(guarded.path);
			return {
				ok: true,
				kind: "image",
				dataUrl: `data:${mime};base64,${data.toString("base64")}`,
				size: info.size,
			};
		}

		if (info.size > MAX_TEXT_BYTES) return { ok: true, kind: "too-large", size: info.size };
		const data = await readFile(guarded.path);
		// A NUL in the first few KB is how git decides "binary" too.
		if (data.subarray(0, 8000).includes(0)) return { ok: true, kind: "binary", size: info.size };
		try {
			return { ok: true, kind: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(data), size: info.size };
		} catch {
			return { ok: true, kind: "text", content: data.toString("latin1"), size: info.size, readOnly: true };
		}
	} catch (error) {
		return fail(message(error));
	}
}

/** Save over an existing file. New files go through `createEntry`. */
export async function writeWorkspaceFile(
	root: string,
	relative: string,
	content: string,
): Promise<WriteResult> {
	if (typeof content !== "string") return fail("Only text can be saved.");
	const guarded = guard(root, relative);
	if (!guarded.ok) return guarded;

	try {
		const info = await stat(guarded.path);
		if (!info.isFile()) return fail("Not a file.");
		await writeFile(guarded.path, content, "utf8");
		return { ok: true };
	} catch (error) {
		return fail(message(error));
	}
}

/** A new empty file or folder. Refuses to replace anything that exists. */
export async function createEntry(
	root: string,
	relative: string,
	kind: "file" | "dir",
): Promise<WriteResult> {
	const guarded = guard(root, relative);
	if (!guarded.ok) return guarded;
	try {
		if (kind === "dir") {
			await mkdir(guarded.path);
		} else {
			await writeFile(guarded.path, "", { flag: "wx" });
		}
		return { ok: true };
	} catch (error) {
		return fail(message(error));
	}
}

export async function renameEntry(root: string, from: string, to: string): Promise<WriteResult> {
	const source = guard(root, from);
	if (!source.ok) return source;
	const target = guard(root, to);
	if (!target.ok) return target;
	try {
		await stat(target.path).then(
			() => {
				throw new Error("Something with that name already exists.");
			},
			() => undefined,
		);
		await rename(source.path, target.path);
		return { ok: true };
	} catch (error) {
		return fail(message(error));
	}
}

export async function deleteEntry(root: string, relative: string): Promise<WriteResult> {
	if (!relative.replace(/[\\/]/g, "")) return fail("The workspace root cannot be deleted.");
	const guarded = guard(root, relative);
	if (!guarded.ok) return guarded;
	try {
		await rm(guarded.path, { recursive: true });
		return { ok: true };
	} catch (error) {
		return fail(message(error));
	}
}
