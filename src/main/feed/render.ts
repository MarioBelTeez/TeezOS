import type { FeedItem } from "../../shared/feed.ts";
import type { Concept, Extraction, SkillDraft } from "./extract.ts";
import { neutraliseExternalImages, PROVENANCE } from "./secure-note.ts";

/**
 * The notes TeezAI writes from a validated extraction. Pure: text in, text
 * out. Values go into the frontmatter as JSON strings (valid YAML, quotes and
 * line breaks escaped), so nothing the model wrote can add a key. Every note
 * still goes through secureFeedNote (feed/secure-note.ts) before it is saved.
 */

const DESCRIPTION_CHARS = 150;

/** YYYY-MM-DD in local time. */
export function localDate(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const quote = (value: string): string => JSON.stringify(value.replace(/\s+/g, " ").trim());

/** A sentence ending this late or later is a better cut than a word with dots. */
const SENTENCE_MIN = 80;

/** About 150 characters of `text`: whole sentences when they fit, else cut at a word. */
function describe(text: string): string {
	const flat = neutraliseExternalImages(text).replace(/\s+/g, " ").trim();
	if (flat.length <= DESCRIPTION_CHARS) return flat;
	// One character over, so a sentence ending exactly at the limit is still seen as whole.
	const sentences = flat.slice(0, DESCRIPTION_CHARS + 1);
	const end = Math.max(sentences.lastIndexOf(". "), sentences.lastIndexOf("! "), sentences.lastIndexOf("? "));
	if (end + 1 >= SENTENCE_MIN) return sentences.slice(0, end + 1);
	const cut = flat.slice(0, DESCRIPTION_CHARS);
	const space = cut.lastIndexOf(" ");
	return `${space > 60 ? cut.slice(0, space) : cut}...`;
}

const frontmatter = (fields: readonly string[]): string => `---\n${fields.join("\n")}\n---\n`;

const kindOf = (item: FeedItem): "video" | "article" | "pdf" => (item.input === "video-file" ? "video" : item.input);

/** A wikilink that names its folder, so another note with the same name elsewhere cannot catch it. */
const link = (folder: string, title: string): string => `[[${folder}/${title}|${title}]]`;
const sourceLink = (title: string): string => link("reference/sources", title);
const conceptLink = (title: string): string => link("brain/concepts", title);

/** The Source note. `conceptLinks` are the file names of the concept notes, which are the wikilink targets. */
export function renderSource(
	extraction: Extraction,
	item: FeedItem,
	date: string,
	conceptLinks: readonly string[],
	toMerge: readonly { readonly name: string; readonly text: string }[] = [],
): string {
	const kind = kindOf(item);
	const out = [
		frontmatter([
			`date: ${date}`,
			`description: ${quote(describe(extraction.summary))}`,
			"tags:",
			"  - source",
			`  - ${kind}`,
			`url: ${quote(item.source)}`,
			`kind: ${kind}`,
			`provenance: ${PROVENANCE}`,
		]),
		`# ${extraction.title}`,
		"",
		"## Summary",
		"",
		extraction.summary,
	];
	if (item.note) out.push("", item.note.split("\n").map((l) => `> ${l}`).join("\n"));
	if (extraction.keyPoints.length > 0) {
		out.push("", "## Key points", "", ...extraction.keyPoints.map((p) => `- ${p.timestamp ? `[${p.timestamp}] ` : ""}${p.text}`));
	}
	if (extraction.quotes.length > 0) out.push("", "## Quotes", "", ...extraction.quotes.map((q) => `> ${q}`));
	if (conceptLinks.length > 0) out.push("", "## Related", "", ...conceptLinks.map((c) => `- ${conceptLink(c)}`));
	if (toMerge.length > 0) {
		out.push("", "## To merge into existing notes", "", ...toMerge.map((m) => `- [[${m.name}]]: ${m.text.replace(/\s+/g, " ").trim()}`));
	}
	return `${out.join("\n")}\n`;
}

/** A new concept note, backlinked to its source. */
export function renderConcept(concept: Concept, sourceTitle: string, date: string): string {
	return `${[
		frontmatter([
			`date: ${date}`,
			`description: ${quote(describe(concept.definition))}`,
			"tags:",
			"  - concept",
			`provenance: ${PROVENANCE}`,
		]),
		`# ${concept.name}`,
		"",
		concept.definition,
		"",
		"## Sources",
		"",
		`- ${sourceLink(sourceTitle)} (${date})`,
	].join("\n")}\n`;
}

/** Whether `text` already has a wikilink to `title` (any case, with or without an alias or heading). */
function linksTo(text: string, title: string): boolean {
	const wanted = title.toLowerCase();
	for (const match of text.matchAll(/\[\[([^\]]*)\]\]/g)) {
		const target = (match[1] ?? "").split(/[|#]/)[0]?.trim().toLowerCase() ?? "";
		if (target === wanted || target === `reference/sources/${wanted}`) return true;
	}
	return false;
}

/**
 * The existing concept note with a section from this source appended, or
 * null when it already links the source (appending twice changes nothing).
 */
export function appendConcept(existing: string, concept: Concept, sourceTitle: string, date: string): string | null {
	if (linksTo(existing, sourceTitle)) return null;
	return `${existing.trimEnd()}\n\n## From ${sourceLink(sourceTitle)} (${date})\n\n${concept.definition}\n`;
}

/** SKILL.md of a draft: only `name` and `description` in the frontmatter (the stamp is added by the secure pass). */
export function renderSkill(skill: SkillDraft): string {
	return `${frontmatter([`name: ${skill.name}`, `description: ${quote(skill.description)}`])}\n${skill.body}\n`;
}
