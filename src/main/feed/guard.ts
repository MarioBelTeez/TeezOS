import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * The write-path rules every note TeezAI writes for the feed goes through.
 *
 * The model has no tools; TeezAI writes the notes itself, under file names
 * computed from text the model returned (titles, concept names, skill
 * names), which is untrusted. This check guarantees, and nothing more:
 * - A write lands only under the vault's `reference/`, `brain/concepts/` or
 *   `thinking/skill-drafts/`, and only as an `.md` file. Every segment of
 *   the path is checked, at any depth (case-insensitive, trailing dots and
 *   spaces ignored as Windows ignores them): no dot names (`.claude`,
 *   `.git`, `.mcp.json`), no 8.3 short names (`CLAUDE~1`), no instruction
 *   files (CLAUDE.md, CLAUDE.local.md, AGENTS.md, GEMINI.md), no `:`
 *   (alternate data streams). Judged both as written and after resolving
 *   links, junctions and short names.
 * - Network paths (two leading separators: UNC, `\\?\`, `\\.\`) are refused
 *   before anything else, and a path is resolved on disk only once it is
 *   lexically inside the vault: this never makes Windows reach a share (an
 *   SMB connection leaks the user's NTLM hash and blocks the main thread).
 * It does not limit what is written inside those three folders.
 */

/**
 * File names never written, at any depth: Claude Code, Codex and Gemini
 * load them as instructions from any folder a later session works in.
 */
const INSTRUCTION_FILES: ReadonlySet<string> = new Set(["claude.md", "claude.local.md", "agents.md", "gemini.md", ".mcp.json"]);
/**
 * The only vault folders the feed writes into. Everything else — CLAUDE.md,
 * AGENTS.md, .mcp.json, other notes — is read-only to it: those files steer
 * later sessions, and the feed writes from untrusted content.
 */
export type WritableFolders = readonly (readonly string[])[];
const WRITABLE: WritableFolders = [["reference"], ["brain", "concepts"], ["thinking", "skill-drafts"]];
/** An 8.3 short name (CLAUDE~1, GIT~1, LONGNA~1.MD): it can stand for any long name, a protected one included. */
const SHORT_NAME = /~\d/;
/** Windows device names, with any extension: opening them reaches a device, not a file. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$|clock\$)$/i;
/** Two leading separators, either way round: a UNC path Windows would open over the network. */
const NETWORK_PATH = /^[\\/]{2}/;

export type RealPath = (target: string) => string;

export const pathApiFor = (vault: string): typeof path.win32 =>
	/^[A-Za-z]:[\\/]/.test(vault) || vault.startsWith("\\\\") ? path.win32 : (path.posix as typeof path.win32);

/**
 * The real path of `target`: its deepest existing part resolved by the OS
 * (links followed, 8.3 short names expanded), with the rest appended as written.
 */
export function realPathOf(target: string): string {
	const api = pathApiFor(target);
	let current = target;
	const rest: string[] = [];
	for (;;) {
		if (existsSync(current)) {
			try {
				return api.join(realpathSync.native(current), ...rest);
			} catch {
				return api.join(current, ...rest);
			}
		}
		const parent = api.dirname(current);
		if (parent === current) return target;
		rest.unshift(api.basename(current));
		current = parent;
	}
}

/** The path of `file` relative to `root`, or null when it is outside (or is the root and `allowRoot` is false). */
function inside(api: typeof path.win32, root: string, file: string, allowRoot: boolean): string | null {
	const rel = api.relative(root, file);
	if (rel === "") return allowRoot ? "" : null;
	return rel.startsWith("..") || api.isAbsolute(rel) ? null : rel;
}

/** A segment as Windows matches it: trailing dots and spaces dropped, case folded. */
const plain = (segment: string): string => segment.replace(/[. ]+$/, "").toLowerCase();

/** Why a vault-relative path, split into segments, may not be written; null when it may. */
function segmentRefusal(segments: readonly string[], writable: WritableFolders): string | null {
	const names = segments.map(plain);
	for (const [index, name] of names.entries()) {
		const shown = segments[index] ?? name;
		if (name.startsWith(".")) return `The feed may not write into ${name} (dot folders and files such as .claude, .git and .mcp.json steer tools).`;
		if (SHORT_NAME.test(name)) return `The feed may not write to ${shown}: an 8.3 short name can stand for a protected folder (.claude, .git, .obsidian).`;
		if (INSTRUCTION_FILES.has(name)) return `The feed may not write ${shown}: instruction files steer later sessions.`;
		if (name.includes(":")) return `The feed may not write to ${shown} (no alternate data streams).`;
		if (DEVICE_NAME.test((name.split(".")[0] ?? name).trimEnd())) return `The feed may not write to ${shown}: it is a Windows device name.`;
	}
	const allowed = writable.some((folder) => names.length > folder.length && folder.every((part, index) => names[index] === part));
	if (!allowed) return "The feed may only write under reference/, brain/concepts/ or thinking/skill-drafts/; the rest of the vault is read-only to it.";
	if (!(names.at(-1) ?? "").endsWith(".md")) return "The feed may only write markdown notes (.md).";
	return null;
}

/**
 * Why `target` (vault-relative, or absolute inside the vault) may not be
 * written by the feed, or null when it may.
 */
export function writePathRefusal(vault: string, target: unknown, real: RealPath = realPathOf, writable: WritableFolders = WRITABLE): string | null {
	const outside = "The feed may only write files inside the vault.";
	if (typeof target !== "string" || target.length === 0) return outside;
	// Before any path is resolved: a network path is never handed to the file system.
	if (NETWORK_PATH.test(target)) return "The feed may not use network paths.";
	const api = pathApiFor(vault);
	const root = api.resolve(vault);
	const full = api.resolve(vault, target);
	// Lexically inside first: nothing outside the vault is resolved on disk.
	if (inside(api, root, full, false) === null) return outside;
	// Where it really lands first (its refusal names the real folder), then as written.
	for (const [base, file] of [
		[real(root), real(full)],
		[root, full],
	] as const) {
		const rel = inside(api, base, file, false);
		if (rel === null) return outside;
		const refusal = segmentRefusal(rel.split(/[\\/]/).filter(Boolean), writable);
		if (refusal) return refusal;
	}
	return null;
}
