import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FeedItem } from "../../shared/feed.ts";
import type { Concept, Extraction } from "./extract.ts";
import { writePathRefusal } from "./guard.ts";
import { matchConcept, safeFileName } from "./names.ts";
import { appendConcept, localDate, renderConcept, renderSkill, renderSource } from "./render.ts";
import { secureFeedNote } from "./secure-note.ts";
import { isSkillName } from "./skills.ts";

/**
 * Writes the notes of one extraction into the vault: the Source note, the
 * concept notes (created, or appended to), and a skill draft. TeezAI writes
 * them itself, so every path is computed here from model-provided names and
 * passes the write rules (feed/guard.ts) before anything touches the disk.
 * Every text goes through secureFeedNote (web images turned into text, the
 * untrusted-provenance stamp). A new file is created exclusively, so nothing
 * is ever overwritten; only an existing concept note is appended to.
 */

export type WriteResult =
	| { readonly ok: true; readonly title: string; readonly changed: readonly string[]; readonly drafts: readonly string[]; readonly warnings: readonly string[] }
	| { readonly ok: false; readonly error: string };

const SOURCES = "reference/sources";
const CONCEPTS = "brain/concepts";
const DRAFTS = "thinking/skill-drafts";
/** Numbered names tried when a title is taken. */
const MAX_SUFFIX = 20;
/** A concept note bigger than this is not appended to. */
const MAX_APPEND_BYTES = 1024 * 1024;
/** Enough of an existing note to read its frontmatter. */
const HEAD_BYTES = 8192;
/** Concept notes listed to the model. */
const MAX_TITLES = 2000;

const absolute = (vault: string, rel: string): string => `${vault.replace(/[\\/]+$/, "")}/${rel}`;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isExists = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "EEXIST";

/** The titles of the concept notes (file names without .md), sorted. */
export async function listConceptTitles(vault: string): Promise<string[]> {
	try {
		const entries = await readdir(absolute(vault, CONCEPTS), { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
			.map((entry) => entry.name.slice(0, -3))
			.sort((a, b) => a.localeCompare(b))
			.slice(0, MAX_TITLES);
	} catch {
		return [];
	}
}

/** Creates `rel` with `text`; false when it already exists. Never overwrites. */
async function createNew(vault: string, rel: string, text: string): Promise<boolean> {
	const file = absolute(vault, rel);
	await mkdir(dirname(file), { recursive: true });
	try {
		await writeFile(file, text, { encoding: "utf8", flag: "wx" });
		return true;
	} catch (error) {
		if (isExists(error)) return false;
		throw error;
	}
}

/** The `url:` of an existing Source note, from its first bytes. */
async function urlOf(vault: string, rel: string): Promise<string | null> {
	try {
		const bytes = (await readFile(absolute(vault, rel))).subarray(0, HEAD_BYTES).toString("utf8");
		const value = /^url:[ \t]*(.+?)[ \t]*$/m.exec(bytes)?.[1];
		if (!value) return null;
		return value.startsWith('"') ? (JSON.parse(value) as string) : value;
	} catch {
		return null;
	}
}

type Target = { readonly concept: Concept; readonly name: string };

/** The concepts that get a note, each with its file name; refused names are reported, duplicates dropped. */
function conceptTargets(vault: string, extraction: Extraction, existing: readonly string[], warnings: string[]): Target[] {
	const seen = new Set<string>();
	const targets: Target[] = [];
	for (const concept of extraction.concepts) {
		const name = matchConcept(concept.name, existing) ?? safeFileName(concept.name, "Concept");
		if (seen.has(name.toLowerCase())) continue;
		const refusal = writePathRefusal(vault, `${CONCEPTS}/${name}.md`);
		if (refusal) {
			warnings.push(`Skipped the concept "${concept.name}": ${refusal}`);
			continue;
		}
		seen.add(name.toLowerCase());
		targets.push({ concept, name });
	}
	return targets;
}

type SourceOutcome = { readonly kind: "written"; readonly title: string; readonly rel: string } | { readonly kind: "duplicate"; readonly title: string } | { readonly kind: "failed"; readonly error: string };

/** Creates the Source note under the first free name; the same link already filed under the title is a duplicate. */
async function writeSource(vault: string, item: FeedItem, extraction: Extraction, date: string, links: readonly string[], toMerge: readonly { readonly name: string; readonly text: string }[]): Promise<SourceOutcome> {
	const base = safeFileName(extraction.title, "Untitled source");
	const text = secureFeedNote(renderSource(extraction, item, date, links, toMerge));
	for (let n = 1; n <= MAX_SUFFIX; n += 1) {
		const title = n === 1 ? base : `${base} (${n})`;
		const rel = `${SOURCES}/${title}.md`;
		const refusal = writePathRefusal(vault, rel);
		if (refusal) return { kind: "failed", error: refusal };
		if (await createNew(vault, rel, text)) return { kind: "written", title, rel };
		if ((await urlOf(vault, rel)) === item.source) return { kind: "duplicate", title };
	}
	return { kind: "failed", error: `There are already ${MAX_SUFFIX} notes titled "${base}".` };
}

/** Appends to an existing concept note; the path when it changed, else null. */
async function appendTo(vault: string, target: Target, sourceTitle: string, date: string, warnings: string[]): Promise<string | null> {
	const rel = `${CONCEPTS}/${target.name}.md`;
	const file = absolute(vault, rel);
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink()) {
		warnings.push(`Left ${rel} alone: it is not a plain file.`);
		return null;
	}
	if (info.size > MAX_APPEND_BYTES) {
		warnings.push(`Left ${rel} alone: it is larger than 1 MB.`);
		return null;
	}
	const next = appendConcept(await readFile(file, "utf8"), target.concept, sourceTitle, date);
	if (next === null) return null;
	// Whole file or nothing: written beside it, then renamed over it.
	const temp = `${file}.${process.pid}.tmp`;
	try {
		await writeFile(temp, secureFeedNote(next), { encoding: "utf8", flag: "wx" });
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
	return rel;
}

/** Creates the concept note, or appends when it turns out to exist. */
async function writeConcept(vault: string, target: Target, sourceTitle: string, date: string, warnings: string[], appendExisting: boolean): Promise<string | null> {
	const rel = `${CONCEPTS}/${target.name}.md`;
	if (await createNew(vault, rel, secureFeedNote(renderConcept(target.concept, sourceTitle, date)))) return rel;
	if (!appendExisting) {
		warnings.push(`Left brain/concepts/${target.name}.md alone: it appeared while writing.`);
		return null;
	}
	return appendTo(vault, target, sourceTitle, date, warnings);
}

/** The skill draft, under the first free name; null when the name or path is refused. */
async function writeSkill(vault: string, extraction: Extraction, warnings: string[]): Promise<string | null> {
	const skill = extraction.skill;
	if (!skill) return null;
	const text = secureFeedNote(renderSkill(skill));
	for (let n = 1; n <= MAX_SUFFIX; n += 1) {
		const name = n === 1 ? skill.name : `${skill.name.slice(0, 56)}-${n}`;
		const rel = `${DRAFTS}/${name}/SKILL.md`;
		const refusal = isSkillName(name) ? writePathRefusal(vault, rel) : "not a valid skill name";
		if (refusal) {
			warnings.push(`Skipped the skill draft: ${refusal}`);
			return null;
		}
		if (await createNew(vault, rel, text)) return name;
	}
	warnings.push("Skipped the skill draft: its name is taken.");
	return null;
}

async function isFolder(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export async function writeNotes(
	vault: string,
	item: FeedItem,
	extraction: Extraction,
	now: number,
	options: { readonly appendExisting?: boolean } = {},
): Promise<WriteResult> {
	const appendExisting = options.appendExisting ?? true;
	if (!(await isFolder(vault))) return { ok: false, error: "The vault folder was not found." };
	const date = localDate(now);
	const warnings: string[] = [];
	const changed: string[] = [];
	const drafts: string[] = [];
	try {
		const existing = await listConceptTitles(vault);
		const all = conceptTargets(vault, extraction, existing, warnings);
		const taken = new Set(existing.map((title) => title.toLowerCase()));
		const isTaken = (t: Target): boolean => taken.has(t.name.toLowerCase());
		const toMerge = appendExisting ? [] : all.filter(isTaken).map((t) => ({ name: t.name, text: t.concept.definition }));
		const targets = appendExisting ? all : all.filter((t) => !isTaken(t));
		const source = await writeSource(vault, item, extraction, date, all.map((t) => t.name), toMerge);
		if (source.kind === "failed") return { ok: false, error: source.error };
		if (source.kind === "duplicate") {
			warnings.push(`"${source.title}" is already in the vault from this link; nothing was written.`);
			return { ok: true, title: source.title, changed, drafts, warnings };
		}
		changed.push(source.rel);
		for (const target of targets) {
			const path = await writeConcept(vault, target, source.title, date, warnings, appendExisting).catch((error: unknown) => {
				warnings.push(`Could not write the concept "${target.name}": ${messageOf(error)}`);
				return null;
			});
			if (path) changed.push(path);
		}
		if (item.kind === "auto" || item.kind === "skill") {
			const draft = await writeSkill(vault, extraction, warnings).catch((error: unknown) => {
				warnings.push(`Could not write the skill draft: ${messageOf(error)}`);
				return null;
			});
			if (draft) {
				drafts.push(draft);
				changed.push(`${DRAFTS}/${draft}/SKILL.md`);
			}
		}
		return { ok: true, title: source.title, changed, drafts, warnings };
	} catch (error) {
		return { ok: false, error: `Could not write the notes: ${messageOf(error)}` };
	}
}
