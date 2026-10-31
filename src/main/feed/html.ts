/**
 * A plain, linear reading of an HTML page: title, headings, paragraphs and
 * list items, with scripts, styles and page furniture dropped.
 *
 * Pages come from the internet and are converted in the main process, so
 * this is a single forward scan (indexOf-based, no backtracking regexes over
 * the markup): every step moves past what it looked at, and the search for a
 * closing tag remembers when none is left. Input is capped first.
 */

/** Characters of HTML converted; the rest of a giant page is dropped. */
export const MAX_HTML = 1_000_000;
const MAX_TAG_NAME = 20;

/** Elements whose content is not text worth reading. */
const SKIP = new Set(["script", "style", "noscript", "svg", "template", "head", "nav", "footer", "iframe"]);
/** Elements whose end starts a new line. */
const BLOCKS = new Set(["p", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "blockquote", "pre", "tr", "table"]);

type Tag = { readonly name: string; readonly closing: boolean };

const isLetter = (code: number): boolean => code >= 97 && code <= 122;
const isNameChar = (code: number): boolean => isLetter(code) || (code >= 48 && code <= 57);

/** The tag starting right after a "<" at `at`, or null when the "<" is just text. */
function readTag(lower: string, at: number): Tag | null {
	const first = lower.charCodeAt(at);
	if (first === 33 || first === 63) return { name: "!", closing: false }; // <!doctype>, <?xml?>
	const closing = first === 47; // "/"
	const start = closing ? at + 1 : at;
	if (!isLetter(lower.charCodeAt(start))) return null;
	let end = start + 1;
	while (end < lower.length && end - start < MAX_TAG_NAME && isNameChar(lower.charCodeAt(end))) end += 1;
	return { name: lower.slice(start, end), closing };
}

function replacement(tag: Tag): string {
	if (!tag.closing && /^h[1-6]$/.test(tag.name)) return `\n\n${"#".repeat(Number(tag.name[1]))} `;
	if (!tag.closing && tag.name === "li") return "\n- ";
	if (tag.name === "br") return "\n";
	if (tag.closing && BLOCKS.has(tag.name)) return "\n";
	return "";
}

function titleOf(html: string, lower: string): string {
	const open = lower.indexOf("<title");
	if (open === -1) return "";
	const gt = html.indexOf(">", open);
	if (gt === -1) return "";
	const close = lower.indexOf("</title", gt);
	return close === -1 ? "" : html.slice(gt + 1, close);
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function safeCodePoint(code: number, fallback: string): string {
	return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, code: string) => {
		if (code[0] === "#" && (code[1] === "x" || code[1] === "X")) return safeCodePoint(parseInt(code.slice(2), 16), whole);
		if (code[0] === "#") return safeCodePoint(parseInt(code.slice(1), 10), whole);
		return ENTITIES[code.toLowerCase()] ?? whole;
	});
}

/** The page's text; one pass over at most MAX_HTML characters. */
function stripMarkup(html: string, lower: string): string {
	// Where the last "</name" is, per element: past it, no closing tag is left to look for.
	const lastClose = new Map<string, number>();
	const closingAfter = (name: string, from: number): number => {
		let last = lastClose.get(name);
		if (last === undefined) {
			last = lower.lastIndexOf(`</${name}`);
			lastClose.set(name, last);
		}
		return last < from ? -1 : lower.indexOf(`</${name}`, from);
	};

	const out: string[] = [];
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt === -1) {
			out.push(html.slice(i));
			break;
		}
		out.push(html.slice(i, lt));
		if (lower.startsWith("<!--", lt)) {
			const end = lower.indexOf("-->", lt + 4);
			i = end === -1 ? html.length : end + 3;
			continue;
		}
		const tag = readTag(lower, lt + 1);
		if (!tag) {
			out.push("<");
			i = lt + 1;
			continue;
		}
		const gt = html.indexOf(">", lt + 1);
		if (gt === -1) break; // an unterminated tag: the rest is markup
		i = gt + 1;
		if (!tag.closing && SKIP.has(tag.name)) {
			const close = closingAfter(tag.name, i);
			if (close !== -1) {
				const end = html.indexOf(">", close);
				i = end === -1 ? html.length : end + 1;
			}
			continue;
		}
		out.push(replacement(tag));
	}
	return out.join("");
}

export function htmlToText(input: string): string {
	const html = input.length > MAX_HTML ? input.slice(0, MAX_HTML) : input;
	// ASCII only: toLowerCase() can change the length of some Unicode text, and the
	// scan relies on `lower` and `html` lining up index for index.
	const lower = html.replace(/[A-Z]+/g, (run) => run.toLowerCase());
	const title = decodeEntities(titleOf(html, lower)).replace(/\s+/g, " ").trim();
	const text = decodeEntities(stripMarkup(html, lower))
		.split("\n")
		.map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return title ? `${title}\n\n${text}` : text;
}
