import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveInsideReal } from "../workspace/guard.ts";

/**
 * The TeezMind vault as Brain shows it: every note with its frontmatter, the
 * wikilinks between them resolved the way Obsidian resolves them (by name,
 * by path, or by alias), and the backlinks that fall out of that.
 *
 * Reading ~300 small files takes a few tens of milliseconds, so the index is
 * rebuilt on demand and cached briefly rather than kept in sync by hand.
 */

export type NoteMeta = {
	readonly path: string;
	readonly title: string;
	readonly folder: string;
	readonly description: string;
	readonly tags: readonly string[];
	readonly aliases: readonly string[];
	readonly status: string;
	readonly date: string;
	readonly modified: number;
	readonly links: readonly string[];
	readonly backlinks: number;
};

export type ParsedNote = Omit<NoteMeta, "backlinks"> & {
	readonly frontmatter: Readonly<Record<string, unknown>>;
	readonly body: string;
};

export type VaultIndex = {
	readonly notes: readonly NoteMeta[];
	readonly edges: readonly { readonly from: string; readonly to: string }[];
	readonly unresolved: readonly { readonly from: string; readonly target: string }[];
};

export type Backlink = { readonly path: string; readonly title: string; readonly context: string };

export type NoteView = {
	readonly meta: NoteMeta;
	readonly frontmatter: Readonly<Record<string, unknown>>;
	readonly body: string;
	readonly backlinks: readonly Backlink[];
	/** "file" is a vault file that is not a note (a .base, a canvas, an image): Obsidian opens it. */
	readonly outgoing: readonly { readonly target: string; readonly path: string | null; readonly kind: LinkKind }[];
};

export type LinkKind = "note" | "file" | "missing";

/** Never scanned, at any depth. */
const SKIP = new Set(["node_modules"]);
/** Non-note files kept for link resolution; a vault pointed at a huge tree stops here. */
const MAX_OTHER_FILES = 20_000;
/** Notes here resolve links (a link to a template is not broken) but are not listed or graphed. */
const RESOLVE_ONLY = new Set(["templates"]);

const asText = (value: unknown): string => (typeof value === "string" ? value : value instanceof Date ? value.toISOString().slice(0, 10) : "");

function asList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
	if (typeof value === "string" && value.trim()) return value.split(",").map((v) => v.trim()).filter(Boolean);
	return [];
}

/** Wikilink targets in a body: aliases, headings and block refs removed; code skipped. */
export function extractLinks(body: string): string[] {
	const withoutCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
	const seen = new Set<string>();
	const links: string[] = [];
	// `[^\[\]\n]` (not just `[^\]\n]`): with "[[" allowed inside a link,
	// a note of repeated "[[" made this quadratic — seconds per scan.
	for (const match of withoutCode.matchAll(/!?\[\[([^[\]\n]+)\]\]/g)) {
		const raw = match[1] ?? "";
		const target = (raw.split("|")[0] ?? "").split("#")[0]?.trim() ?? "";
		if (!target || seen.has(target)) continue;
		seen.add(target);
		links.push(target);
	}
	return links;
}

export function parseNote(relative: string, text: string, modified: number): ParsedNote {
	let frontmatter: Record<string, unknown> = {};
	let body = text;
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (match) {
		body = text.slice(match[0].length);
		try {
			const parsed: unknown = parseYaml(match[1] ?? "");
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
		} catch {
			// Broken YAML: keep the note, lose only its properties.
		}
	}
	const base = path.posix.basename(relative, ".md");
	const folder = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
	return {
		path: relative,
		title: base,
		folder,
		description: asText(frontmatter["description"]),
		tags: asList(frontmatter["tags"]),
		aliases: asList(frontmatter["aliases"]),
		status: asText(frontmatter["status"]),
		date: asText(frontmatter["date"]),
		modified,
		links: extractLinks(body),
		frontmatter,
		body,
	};
}

/** QMD's name for a vault path: each run of other characters becomes "-". */
export function slugPath(relative: string): string {
	return relative
		.split("/")
		.map((part) => part.replace(/[^A-Za-z0-9._]+/g, "-").replace(/^-+|-+$/g, ""))
		.join("/");
}

/** The notes, and every other file a link may point at (templates, .base, images…). */
async function walk(root: string): Promise<{ notes: { path: string; modified: number }[]; others: string[] }> {
	const notes: { path: string; modified: number }[] = [];
	const others: string[] = [];
	const queue: { relative: string; listed: boolean }[] = [{ relative: "", listed: true }];
	while (queue.length > 0) {
		const { relative, listed } = queue.shift() ?? { relative: "", listed: true };
		let entries;
		try {
			entries = await readdir(path.join(root, relative), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
				queue.push({ relative: child, listed: listed && !(relative === "" && RESOLVE_ONLY.has(entry.name)) });
			} else if (entry.isFile() && entry.name.endsWith(".md") && listed) {
				const info = await stat(path.join(root, child));
				notes.push({ path: child, modified: Math.round(info.mtimeMs) });
			} else if (entry.isFile() && others.length < MAX_OTHER_FILES) {
				others.push(child);
			}
		}
	}
	return { notes, others };
}

const linkKey = (target: string): string => target.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();

/** `[[target]]` among files that are not listed notes: by path, then by name (".md" optional). */
function makeFileResolver(files: readonly string[]): (target: string) => string | null {
	const byPath = new Map<string, string>();
	const byName = new Map<string, string>();
	const add = (map: Map<string, string>, key: string, file: string): void => {
		const existing = map.get(key);
		if (!existing || file.length < existing.length) map.set(key, file);
	};
	for (const file of files) {
		const lower = file.toLowerCase();
		const name = lower.slice(lower.lastIndexOf("/") + 1);
		add(byPath, lower, file);
		add(byName, name, file);
		if (lower.endsWith(".md")) {
			add(byPath, lower.slice(0, -3), file);
			add(byName, name.slice(0, -3), file);
		}
	}
	return (target) => {
		const key = linkKey(target);
		return byPath.get(key) ?? (key.includes("/") ? null : (byName.get(key) ?? null));
	};
}

/** How Obsidian picks a note for `[[target]]`: path, then name, then alias. */
function makeResolver(notes: readonly ParsedNote[]): (target: string) => string | null {
	const byPath = new Map<string, string>();
	const byName = new Map<string, string>();
	const byAlias = new Map<string, string>();
	for (const note of notes) {
		byPath.set(note.path.toLowerCase(), note.path);
		byPath.set(note.path.slice(0, -3).toLowerCase(), note.path);
		const name = note.title.toLowerCase();
		// Shortest path wins a name clash, as in Obsidian's "shortest path" mode.
		const existing = byName.get(name);
		if (!existing || note.path.length < existing.length) byName.set(name, note.path);
		for (const alias of note.aliases) byAlias.set(alias.toLowerCase(), note.path);
	}
	return (target) => {
		const key = linkKey(target);
		const direct = byPath.get(key) ?? byPath.get(`${key}.md`);
		if (direct) return direct;
		if (key.includes("/")) {
			for (const [candidate, notePath] of byPath) {
				if (candidate.endsWith(`/${key}`) || candidate.endsWith(`/${key}.md`)) return notePath;
			}
			return null;
		}
		return byName.get(key.replace(/\.md$/, "")) ?? byAlias.get(key) ?? null;
	};
}

type Built = {
	readonly at: number;
	readonly parsed: readonly ParsedNote[];
	readonly index: VaultIndex;
	readonly resolveFile: (target: string) => string | null;
};
const cache = new Map<string, Built>();
const MAX_NOTE_CHARS = 1_000_000;
const FRESH_MS = 3000;

/** Scans in progress: callers arriving meanwhile wait for the same one. */
const building = new Map<string, Promise<Built>>();

function build(root: string): Promise<Built> {
	const hit = cache.get(root);
	if (hit && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit);
	const running = building.get(root);
	if (running) return running;
	const scan = scanVaultFiles(root).finally(() => building.delete(root));
	building.set(root, scan);
	return scan;
}

async function scanVaultFiles(root: string): Promise<Built> {
	const { notes: files, others } = await walk(root);
	const resolveFile = makeFileResolver(others);
	const parsed = await Promise.all(
		files.map(async (file) => {
			const text = await readFile(path.join(root, file.path), "utf8");
			// A note is prose; anything this big is a paste or an attack, and its
			// links are not worth a stalled index.
			return parseNote(file.path, text.length > MAX_NOTE_CHARS ? text.slice(0, MAX_NOTE_CHARS) : text, file.modified);
		}),
	);
	const resolve = makeResolver(parsed);
	const edges: { from: string; to: string }[] = [];
	const unresolved: { from: string; target: string }[] = [];
	const backlinkCount = new Map<string, number>();
	for (const note of parsed) {
		for (const target of note.links) {
			const to = resolve(target);
			if (!to) {
				// A template, a .base or an image is there, just not a note in the graph.
				if (!resolveFile(target)) unresolved.push({ from: note.path, target });
				continue;
			}
			if (to === note.path) continue;
			edges.push({ from: note.path, to });
			backlinkCount.set(to, (backlinkCount.get(to) ?? 0) + 1);
		}
	}
	const notes: NoteMeta[] = parsed.map(({ frontmatter: _f, body: _b, ...meta }) => ({
		...meta,
		backlinks: backlinkCount.get(meta.path) ?? 0,
	}));
	const built: Built = { at: Date.now(), parsed, index: { notes, edges, unresolved }, resolveFile };
	cache.set(root, built);
	return built;
}

export async function scanVault(root: string): Promise<VaultIndex> {
	return (await build(root)).index;
}

/** One note to read, with its backlinks and the line around each mention. */
export async function readNote(root: string, relative: string): Promise<NoteView | null> {
	if (!relative.endsWith(".md") || !resolveInsideReal(root, relative).ok) return null;
	const built = await build(root);
	let note = built.parsed.find((n) => n.path === relative);
	if (!note) {
		// Not indexed yet (just created): read it directly.
		try {
			const full = path.join(root, relative);
			note = parseNote(relative, await readFile(full, "utf8"), Math.round((await stat(full)).mtimeMs));
		} catch {
			return null;
		}
	}
	const resolve = makeResolver(built.parsed);
	const backlinks: Backlink[] = [];
	for (const other of built.parsed) {
		if (other.path === note.path) continue;
		if (!other.links.some((target) => resolve(target) === note.path)) continue;
		const line =
			other.body.split(/\r?\n/).find((l) => {
				for (const m of l.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
					const target = (m[1] ?? "").split("|")[0]?.split("#")[0]?.trim() ?? "";
					if (resolve(target) === note.path) return true;
				}
				return false;
			}) ?? "";
		backlinks.push({ path: other.path, title: other.title, context: line.trim().slice(0, 240) });
	}
	const meta = built.index.notes.find((n) => n.path === note.path) ?? { ...note, backlinks: backlinks.length };
	return {
		meta: { ...meta, backlinks: backlinks.length },
		frontmatter: note.frontmatter,
		body: note.body,
		backlinks: backlinks.sort((a, b) => a.title.localeCompare(b.title)),
		outgoing: note.links.map((target) => {
			const notePath = resolve(target) ?? built.resolveFile(target);
			if (!notePath) return { target, path: null, kind: "missing" as const };
			return { target, path: notePath, kind: notePath.endsWith(".md") ? ("note" as const) : ("file" as const) };
		}),
	};
}

/** Drop the cache, e.g. after the watcher reports a change in the vault. */
export function invalidateVault(root: string): void {
	cache.delete(root);
}
