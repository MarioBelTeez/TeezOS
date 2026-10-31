/**
 * A remark plugin for the Obsidian syntax notes use and plain markdown lacks:
 *
 *  - `[[Note]]`, `[[Note|label]]`, `[[Note#Heading]]`, `![[embed]]` become
 *    links to `wikilink:<target>`, which the reader turns into navigation;
 *  - `> [!info] Title` blockquotes become callouts (`div.callout.callout-info`
 *    with a `.callout-title`);
 *  - `==text==` becomes `<mark>`.
 *
 * It walks the markdown tree directly and touches only text outside code and
 * existing links, so a `[[` inside a code span is left alone.
 */

type Node = {
	type: string;
	value?: string;
	url?: string;
	children?: Node[];
	data?: { hName?: string; hProperties?: Record<string, unknown> };
};

export const WIKILINK_PREFIX = "wikilink:";

const INLINE = /(!?)\[\[([^[\]\n]+)\]\]|==([^=\n]+)==/g;

function splitText(value: string): Node[] | null {
	INLINE.lastIndex = 0;
	if (!INLINE.test(value)) return null;
	INLINE.lastIndex = 0;
	const out: Node[] = [];
	let last = 0;
	for (const match of value.matchAll(INLINE)) {
		const index = match.index ?? 0;
		if (index > last) out.push({ type: "text", value: value.slice(last, index) });
		if (match[3] !== undefined) {
			out.push({ type: "highlight", data: { hName: "mark" }, children: [{ type: "text", value: match[3] }] });
		} else {
			const embed = match[1] === "!";
			const raw = match[2] ?? "";
			const [targetPart = "", labelPart] = raw.split("|");
			const target = targetPart.trim();
			const heading = target.includes("#") ? target.slice(target.indexOf("#") + 1).replace(/^\^/, "") : "";
			const label = labelPart?.trim() || (heading && !target.startsWith("#") ? `${target.split("#")[0]} › ${heading}` : target.replace(/^#/, ""));
			out.push({
				type: "link",
				url: `${WIKILINK_PREFIX}${encodeURIComponent(target)}`,
				data: { hProperties: { className: embed ? "wikilink embed" : "wikilink" } },
				children: [{ type: "text", value: embed ? `⧉ ${label}` : label }],
			});
		}
		last = index + match[0].length;
	}
	if (last < value.length) out.push({ type: "text", value: value.slice(last) });
	return out;
}

function transformCallout(node: Node): void {
	const first = node.children?.[0];
	if (!first || first.type !== "paragraph") return;
	const text = first.children?.[0];
	if (!text || text.type !== "text" || !text.value) return;
	const match = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)\n?/.exec(text.value);
	if (!match) return;
	const kind = (match[1] ?? "note").toLowerCase();
	const title = match[3]?.trim() || kind.charAt(0).toUpperCase() + kind.slice(1);
	text.value = text.value.slice(match[0].length);
	if (!text.value && first.children) first.children.shift();
	// A soft break right after the title line would leave a blank first line.
	if (first.children?.[0]?.type === "break") first.children.shift();
	node.data = { hName: "div", hProperties: { className: `callout callout-${kind}`, "data-callout": kind } };
	const titleNode: Node = {
		type: "paragraph",
		data: { hName: "div", hProperties: { className: "callout-title" } },
		children: [{ type: "text", value: title }],
	};
	node.children = [titleNode, ...(first.children && first.children.length > 0 ? [first] : []), ...(node.children?.slice(1) ?? [])];
}

function walk(node: Node): void {
	if (node.type === "blockquote") transformCallout(node);
	if (!node.children || node.type === "link" || node.type === "inlineCode" || node.type === "code") return;
	const next: Node[] = [];
	for (const child of node.children) {
		if (child.type === "text" && child.value) {
			const parts = splitText(child.value);
			if (parts) {
				next.push(...parts);
				continue;
			}
		}
		walk(child);
		next.push(child);
	}
	node.children = next;
}

export function remarkObsidian() {
	return (tree: unknown): void => walk(tree as Node);
}
