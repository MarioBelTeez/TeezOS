import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { writePathRefusal, type WritableFolders } from "../../../src/main/feed/guard.ts";
import { safeFileName } from "../../../src/main/feed/names.ts";

export const MAX_CAPTURE_CHARS = 4000;
const DESCRIPTION_CHARS = 150;
const SLUG_WORDS = 6;
const MAX_NUMBERED = 20;

/** The only folders the phone writes into, on top of the feed's own path rules. */
const PHONE_WRITABLE: WritableFolders = [["thinking"], ["reference", "sources"], ["brain", "concepts"]];

export type WriteResult = { ok: true; rel: string } | { ok: false; error: string };

/** `name.md` -> `name-2.md`: the number goes before the extension. */
function numbered(rel: string, n: number): string {
	const ext = path.posix.extname(rel);
	return `${rel.slice(0, rel.length - ext.length)}-${n}${ext}`;
}

/**
 * Creates a note that does not exist yet, never touches one that does.
 * When the name is taken it tries `-2` ... `-20`.
 */
export async function writeNewNote(vault: string, rel: string, content: string): Promise<WriteResult> {
	// The guard also accepts absolute paths inside the vault, and path.join would not
	// treat them as absolute: only a plain relative POSIX path goes any further.
	if (rel.startsWith("/") || rel.includes("\\") || /^[A-Za-z]:/.test(rel) || path.isAbsolute(rel)) {
		return { ok: false, error: "The phone may only write to a vault-relative path." };
	}
	for (let n = 1; n <= MAX_NUMBERED; n++) {
		const candidate = n === 1 ? rel : numbered(rel, n);
		const refusal = writePathRefusal(vault, candidate, undefined, PHONE_WRITABLE);
		if (refusal !== null) return { ok: false, error: refusal };
		const full = path.join(vault, candidate);
		await mkdir(path.dirname(full), { recursive: true });
		try {
			const handle = await open(full, "wx");
			try {
				await handle.writeFile(content, "utf8");
			} finally {
				await handle.close();
			}
			return { ok: true, rel: candidate };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, error: `Could not write ${candidate}.` };
		}
	}
	return { ok: false, error: `Every name for ${rel} up to -${MAX_NUMBERED} is taken.` };
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** A YAML double-quoted scalar for one line of text. */
const yamlString = (text: string): string => `"${text.replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Who a capture comes from: the user ("phone") or a chat reply's capture block ("phone-chat"). */
export type CaptureProvenance = "phone" | "phone-chat";

/** The note a captured thought becomes: file name, frontmatter, text, related links. */
export function captureNote(text: string, now: number, links: readonly string[], provenance: CaptureProvenance = "phone"): { rel: string; content: string } {
	const body = text.slice(0, MAX_CAPTURE_CHARS);
	const when = new Date(now);
	const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}`;
	const slug = safeFileName(body.trim().split(/\s+/).slice(0, SLUG_WORDS).join(" "), "note");
	const date = stamp.slice(0, 10);
	const related = links.length > 0 ? `\n\n## Related\n\n${links.map((title) => `[[${title}]]`).join("\n")}` : "";
	const content = [
		"---",
		`date: ${date}`,
		`description: ${yamlString(body.slice(0, DESCRIPTION_CHARS))}`,
		"tags: [thinking, phone-capture]",
		`provenance: ${provenance}`,
		"---",
		"",
		`${body}${related}`,
		"",
	].join("\n");
	return { rel: `thinking/phone-${stamp}-${slug}.md`, content };
}
