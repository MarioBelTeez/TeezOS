import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Skill drafts a feed job wrote, and the two things the user can do with one.
 *
 * A job may only draft into `thinking/skill-drafts/<name>/`; nothing becomes
 * a live skill until the user has seen it (SKILL.md and the full file list, from
 * `previewDraft`) and confirmed, after which Install copies exactly what he
 * saw into `.claude/skills/<name>/` — never over an existing skill, and not
 * at all when the draft changed since the preview. A draft holding anything
 * but markdown, or whose SKILL.md frontmatter sets `allowed-tools` or
 * `hooks`, is refused with a reason. Every name is checked against one strict
 * pattern before it is joined to a path, and links inside a draft are refused
 * rather than followed.
 */

export type SkillResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
export type DraftPreview =
	| { readonly ok: true; readonly skillMd: string; readonly files: readonly string[]; readonly digest: string }
	| { readonly ok: false; readonly reason: string };

const NAME = /^[a-z0-9-]{1,60}$/;
/** Most files a draft may hold; a skill is a few markdown files, not a tree. */
const MAX_FILES = 200;
/** Most bytes a draft may hold in all; more is not something the user can review. */
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
export const DIGEST = /^[0-9a-f]{64}$/;
const FRONTMATTER_ONLY = "SKILL.md frontmatter may only have name and description";
/** A top-level `name:` or `description:` key (plain, lower case) and what follows it. */
const ALLOWED_KEY = /^(name|description):(?:[ \t]+(.*))?$/;
/** The feed's own stamp (feed/secure-note.ts), written into every note a job wrote, SKILL.md included. */
const PROVENANCE_STAMP = /^provenance:[ \t]+feed-untrusted[ \t]*(#.*)?$/;
const COMMENT_TAIL = String.raw`[ \t]*(?:#.*)?`;
/** A block scalar header: `|` or `>` with optional chomping/indentation indicators. */
const BLOCK_SCALAR = new RegExp(String.raw`^[|>](?:[+-]?[1-9]?|[1-9][+-])${COMMENT_TAIL}$`);
const DOUBLE_QUOTED = new RegExp(String.raw`^"(?:[^"\\]|\\.)*"${COMMENT_TAIL}$`);
const SINGLE_QUOTED = new RegExp(String.raw`^'(?:[^']|'')*'${COMMENT_TAIL}$`);
/** A plain one-line value: no YAML indicator first, no ": " (a nested mapping) inside. */
const PLAIN_VALUE = /^(?![-?:,[\]{}#&*!|>'"%@`])(?:(?!: |:$)[^\n])*$/;

/** The frontmatter lines of a SKILL.md (all of it when an opened block never closes); leading blank lines are skipped. */
function frontmatterLines(skillMd: string): string[] {
	const text = skillMd.charCodeAt(0) === 0xfeff ? skillMd.slice(1) : skillMd;
	const lines = text.split(/\r?\n/);
	const first = lines.findIndex((line) => line.trim() !== "");
	if (first < 0 || lines[first]?.trim() !== "---") return [];
	const end = lines.findIndex((line, index) => index > first && (line.trimEnd() === "---" || line.trimEnd() === "..."));
	return end < 0 ? lines.slice(first + 1) : lines.slice(first + 1, end);
}

/**
 * Whether SKILL.md's frontmatter holds only what a feed draft may: top-level
 * `name` and `description` with a plain, quoted or block-scalar (`|`/`>`)
 * value, the feed's `provenance: feed-untrusted` stamp, comments and blank
 * lines. An allow-list, so no YAML spelling of another key (explicit `?`
 * keys, flow mappings, anchors, tags, escaped quotes) gets through.
 */
function frontmatterAllowed(lines: readonly string[]): boolean {
	let inBlock = false;
	for (const line of lines) {
		if (line.trim() === "") continue;
		const indented = /^[ \t]/.test(line);
		if (inBlock && indented) continue; // the block scalar's text, whatever it says
		inBlock = false;
		if (indented) return false;
		if (line.startsWith("#") || PROVENANCE_STAMP.test(line)) continue;
		const key = ALLOWED_KEY.exec(line);
		if (!key) return false;
		const value = (key[2] ?? "").trimEnd();
		if (BLOCK_SCALAR.test(value)) inBlock = true;
		else if (value === "" || !(DOUBLE_QUOTED.test(value) || SINGLE_QUOTED.test(value) || PLAIN_VALUE.test(value))) return false;
	}
	return true;
}

/**
 * Why a draft may not be installed, or null: every file must be markdown, and
 * SKILL.md's frontmatter may only have name and description (so never
 * allowed-tools, hooks, model or anything else that changes what a skill can do).
 */
export function draftRefusal(files: readonly string[], skillMd: string): string | null {
	const other = files.find((file) => !/\.md$/i.test(file));
	if (other !== undefined) return `The draft holds ${other.replace(/\\/g, "/")}, which is not markdown; a feed draft installs only markdown files.`;
	return frontmatterAllowed(frontmatterLines(skillMd)) ? null : FRONTMATTER_ONLY;
}

export function isSkillName(name: string): boolean {
	return typeof name === "string" && NAME.test(name);
}

const draftsRoot = (vault: string): string => join(vault, "thinking", "skill-drafts");

async function kind(path: string): Promise<"file" | "dir" | "link" | "other" | null> {
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink()) return "link";
		if (stat.isDirectory()) return "dir";
		if (stat.isFile()) return "file";
		return "other";
	} catch {
		return null;
	}
}

/**
 * True when `path`, with every link resolved, is exactly `<real vault>/...parts`:
 * no junction or symlink anywhere along the way (thinking, skill-drafts,
 * .claude, the draft itself) can send the operation somewhere else.
 */
async function isExactly(vault: string, path: string, parts: readonly string[]): Promise<boolean> {
	try {
		const [root, real] = await Promise.all([realpath(vault), realpath(path)]);
		return relative(join(root, ...parts), real) === "";
	} catch {
		return false;
	}
}

/** The draft's folder, or why it cannot be used. */
async function draftFolder(vault: string, name: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
	if (!isSkillName(name)) return { ok: false, reason: "That is not a valid skill name." };
	const path = join(draftsRoot(vault), name);
	const found = await kind(path);
	if (found === null) return { ok: false, reason: `There is no draft called ${name}.` };
	if (found !== "dir") return { ok: false, reason: `The draft ${name} is not a plain folder.` };
	if (!(await isExactly(vault, path, ["thinking", "skill-drafts", name]))) {
		return { ok: false, reason: `The draft ${name} is not inside thinking/skill-drafts.` };
	}
	return { ok: true, path };
}

/** Every file in the draft, relative; refuses links and anything that is not a file or folder. */
async function collect(root: string): Promise<{ ok: true; files: string[]; dirs: string[] } | { ok: false; reason: string }> {
	const files: string[] = [];
	const dirs: string[] = [];
	const walk = async (rel: string): Promise<string | null> => {
		const entries = await readdir(join(root, rel), { withFileTypes: true });
		for (const entry of entries) {
			const child = rel ? join(rel, entry.name) : entry.name;
			const found = await kind(join(root, child));
			if (found === "dir") {
				dirs.push(child);
				const problem = await walk(child);
				if (problem) return problem;
			} else if (found === "file") {
				files.push(child);
				if (files.length > MAX_FILES) return `The draft holds more than ${MAX_FILES} files.`;
			} else {
				return `The draft holds a link or special file (${child}); install refused.`;
			}
		}
		return null;
	};
	const problem = await walk("");
	return problem ? { ok: false, reason: problem } : { ok: true, files, dirs };
}

type ReadDraft = {
	readonly ok: true;
	readonly dirs: readonly string[];
	/** Every file's bytes, by path relative to the draft. */
	readonly contents: ReadonlyMap<string, Buffer>;
	readonly skillMd: string;
	readonly digest: string;
};

/** The whole draft in memory, checked by draftRefusal, with a digest of its names and bytes. */
async function readDraft(vault: string, name: string): Promise<ReadDraft | { ok: false; reason: string }> {
	const draft = await draftFolder(vault, name);
	if (!draft.ok) return draft;
	if ((await kind(join(draft.path, "SKILL.md"))) !== "file") return { ok: false, reason: `The draft ${name} has no SKILL.md.` };
	const listed = await collect(draft.path);
	if (!listed.ok) return listed;
	const contents = new Map<string, Buffer>();
	let total = 0;
	try {
		for (const file of [...listed.files].sort()) {
			const bytes = await readFile(join(draft.path, file));
			total += bytes.byteLength;
			if (total > MAX_DRAFT_BYTES) return { ok: false, reason: `The draft is larger than ${MAX_DRAFT_BYTES / 1024 / 1024} MB; too much to review.` };
			contents.set(file, bytes);
		}
	} catch (error) {
		return { ok: false, reason: `Could not read the draft: ${message(error)}` };
	}
	const skillMd = (contents.get("SKILL.md") ?? Buffer.alloc(0)).toString("utf8");
	const refusal = draftRefusal([...contents.keys()], skillMd);
	if (refusal) return { ok: false, reason: refusal };
	const hash = createHash("sha256");
	for (const [file, bytes] of contents) hash.update(`${file.replace(/\\/g, "/")}\0${bytes.byteLength}\0`).update(bytes);
	return { ok: true, dirs: listed.dirs, contents, skillMd, digest: hash.digest("hex") };
}

/** What the user confirms before an install: SKILL.md, every file, and a digest that pins this exact version. */
export async function previewDraft(vault: string, name: string): Promise<DraftPreview> {
	const draft = await readDraft(vault, name);
	if (!draft.ok) return draft;
	return { ok: true, skillMd: draft.skillMd, files: [...draft.contents.keys()].map((file) => file.replace(/\\/g, "/")), digest: draft.digest };
}

/**
 * Copy a draft into `.claude/skills/<name>/`. Never overwrites an installed
 * skill. With `digest` (from previewDraft), only the version the user reviewed
 * is installed: the bytes written are the ones that were checked.
 */
export async function installSkill(vault: string, name: string, digest?: string): Promise<SkillResult> {
	const draft = await readDraft(vault, name);
	if (!draft.ok) return draft;
	if (digest !== undefined && digest !== draft.digest) return { ok: false, reason: `The draft ${name} changed since you reviewed it; open it again.` };

	const claude = join(vault, ".claude");
	const skills = join(claude, "skills");
	const target = join(skills, name);
	// Checked before anything is created: a linked .claude or .claude/skills
	// must never get a folder made at the place it points to.
	for (const [path, parts] of [[claude, [".claude"]], [skills, [".claude", "skills"]]] as const) {
		const found = await kind(path);
		if (found !== null && (found !== "dir" || !(await isExactly(vault, path, parts)))) {
			return { ok: false, reason: `${parts.join("/")} is not a plain folder in the vault.` };
		}
	}
	if ((await kind(target)) !== null) return { ok: false, reason: `A skill called ${name} is already installed.` };

	try {
		await mkdir(skills, { recursive: true });
		// Again after creating, in case something swapped a link in meanwhile.
		if (!(await isExactly(vault, skills, [".claude", "skills"]))) return { ok: false, reason: ".claude/skills is not a plain folder in the vault." };
		// Not recursive: if another install raced this one, this fails instead of merging.
		await mkdir(target);
	} catch (error) {
		return { ok: false, reason: `Could not create ${name}: ${message(error)}` };
	}
	try {
		for (const dir of draft.dirs) await mkdir(join(target, dir), { recursive: true });
		for (const [file, bytes] of draft.contents) await writeFile(join(target, file), bytes, { flag: "wx" });
	} catch (error) {
		// A half-copied skill would load broken; take it out again.
		await rm(target, { recursive: true, force: true }).catch(() => undefined);
		return { ok: false, reason: `Install failed: ${message(error)}` };
	}
	return { ok: true };
}

/** Delete a draft folder; only ever one inside `thinking/skill-drafts/`. */
export async function discardDraft(vault: string, name: string): Promise<SkillResult> {
	const draft = await draftFolder(vault, name);
	if (!draft.ok) return draft;
	try {
		await rm(draft.path, { recursive: true, force: true });
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `Could not discard ${name}: ${message(error)}` };
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
