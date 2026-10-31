/**
 * Capture blocks: how the read-only chat agent asks the service to remember
 * something. The agent cannot write files; it ends a reply with
 * `<teez-capture links="A|B">text</teez-capture>` and the service, not the
 * model, decides where that goes (always a new capture note). Only the text
 * and the link titles are taken; any other attribute (a path, a file name) is
 * ignored, so a reply can never choose a location.
 */

export type Capture = { text: string; links: string[] };

const OPEN = "<teez-capture";
const CLOSE = "</teez-capture>";
const BLOCK = /<teez-capture\b([^>]*)>([\s\S]*?)<\/teez-capture>/g;
const UNCLOSED = /<teez-capture\b[\s\S]*$/;
const LINKS_ATTR = /\blinks\s*=\s*"([^"]*)"/;
// Wikilink syntax plus every control character (newlines included).
const LINK_UNSAFE = /[[\]|#^\u0000-\u001f\u007f]/g;

export const MAX_CAPTURES = 5;
export const MAX_CAPTURE_TEXT = 4000;
const MAX_LINKS = 10;
const MAX_LINK_CHARS = 120;

/** Link titles safe to render as `[[title]]`: no brackets, pipes, headings, block refs or control characters. */
export function sanitiseLinks(raw: string): string[] {
	return raw
		.split("|")
		.map((title) => title.replace(LINK_UNSAFE, "").trim().slice(0, MAX_LINK_CHARS).trim())
		.filter((title) => title.length > 0)
		.slice(0, MAX_LINKS);
}

/** The reply as shown (every block removed) and up to five captures, each cut to 4000 characters. */
export function parseCaptureBlocks(reply: string): { text: string; captures: Capture[] } {
	const captures: Capture[] = [];
	const shown = reply.replace(BLOCK, (_match, attrs: string, body: string) => {
		const text = body.trim().slice(0, MAX_CAPTURE_TEXT).trim();
		if (text.length > 0 && captures.length < MAX_CAPTURES) {
			captures.push({ text, links: sanitiseLinks(LINKS_ATTR.exec(attrs)?.[1] ?? "") });
		}
		return "";
	});
	return { text: shown.replace(UNCLOSED, "").trim(), captures };
}

/** How many characters at the end of `text` could be the start of `token`. */
function partialSuffix(text: string, token: string): number {
	for (let k = Math.min(token.length - 1, text.length); k > 0; k -= 1) {
		if (text.endsWith(token.slice(0, k))) return k;
	}
	return 0;
}

/**
 * The same removal for a reply that arrives in pieces: text inside a block (or
 * that may be the start of one) is held back, so a capture block never shows
 * on the phone, even for a moment.
 */
export class CaptureStreamFilter {
	#held = "";
	#inside = false;

	push(delta: string): string {
		let buffer = this.#held + delta;
		let out = "";
		for (;;) {
			const token = this.#inside ? CLOSE : OPEN;
			const at = buffer.indexOf(token);
			if (at >= 0) {
				if (!this.#inside) out += buffer.slice(0, at);
				buffer = buffer.slice(at + token.length);
				this.#inside = !this.#inside;
				continue;
			}
			const keep = partialSuffix(buffer, token);
			if (!this.#inside) out += buffer.slice(0, buffer.length - keep);
			this.#held = buffer.slice(buffer.length - keep);
			return out;
		}
	}

	/** What was held back at the end of the reply; nothing if a block never closed. */
	flush(): string {
		const rest = this.#inside ? "" : this.#held;
		this.#held = "";
		this.#inside = false;
		return rest;
	}
}
