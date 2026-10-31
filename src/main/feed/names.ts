/**
 * File names from model-provided text. Titles, concept names and skill names
 * come from a model that read untrusted content, so none of them is ever used
 * as a path as it is: each is reduced to a safe file name first. The result is
 * also a valid wikilink target (no `[`, `]`, `#`, `^`, `|`).
 */

const MAX_NAME = 80;
const MAX_SKILL_NAME = 60;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
/** Zero-width, bidi override and isolate characters, the BOM. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
/** Invalid in Windows file names, plus what breaks a wikilink target. */
const UNSAFE = /[<>:"/\\|?*[\]#^]/g;
/** Hyphen and dash lookalikes (U+2010–U+2015, minus sign): a typed `[[short-form]]` would never reach `short‐form`. */
const DASHES = /[‐-―−﹘﹣]/g;
/** Curly single quotes and primes, typed as a plain apostrophe. */
const APOSTROPHES = /[‘’‛′]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$|clock\$)$/i;
/** Names Claude Code, Codex and Gemini load as instructions (with or without .md). */
const INSTRUCTION = /^(claude|claude\.local|agents|gemini)(\.md)?$/i;

/** A safe file base name (no extension) for `raw`; `fallback` when nothing usable is left. */
export function safeFileName(raw: string, fallback: string): string {
	let name = raw
		.normalize("NFKC")
		.replace(CONTROL, " ")
		.replace(INVISIBLE, " ")
		.replace(UNSAFE, " ")
		.replace(DASHES, "-")
		.replace(APOSTROPHES, "'")
		.replace(/~/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	name = name.replace(/^[. ]+|[. ]+$/g, "").slice(0, MAX_NAME).replace(/^[. ]+|[. ]+$/g, "");
	if (name === "") return fallback;
	const stem = (name.split(".")[0] ?? name).trimEnd();
	if (INSTRUCTION.test(name)) return `${name} note`;
	if (RESERVED.test(stem)) return `${stem} note${name.slice((name.split(".")[0] ?? name).length)}`;
	return name;
}

/** A skill folder name (`a-z`, digits, dashes, at most 60), or null when nothing is left. */
export function safeSkillName(raw: string): string | null {
	const name = raw
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SKILL_NAME)
		.replace(/-+$/g, "");
	return name === "" ? null : name;
}

const key = (name: string): string => safeFileName(name, "").toLowerCase();

/** The existing title `name` matches (same name, any case, after sanitising), or null. */
export function matchConcept(name: string, existing: readonly string[]): string | null {
	const wanted = key(name);
	if (wanted === "") return null;
	return existing.find((title) => key(title) === wanted) ?? null;
}
