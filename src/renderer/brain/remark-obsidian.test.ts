import { describe, expect, test } from "vitest";
import { remarkObsidian } from "./remark-obsidian.ts";

type Node = { type: string; value?: string; url?: string; children?: Node[]; data?: Record<string, unknown> };

const run = (tree: Node): Node => {
	remarkObsidian()(tree);
	return tree;
};
const p = (...children: Node[]): Node => ({ type: "paragraph", children });
const t = (value: string): Node => ({ type: "text", value });

describe("remarkObsidian", () => {
	test("wikilinks become links with their label", () => {
		const tree = run({ type: "root", children: [p(t("See [[North Star]] and [[Proxmox Homelab Server|the server]]."))] });
		const kids = tree.children?.[0]?.children ?? [];
		expect(kids.map((k) => k.type)).toEqual(["text", "link", "text", "link", "text"]);
		expect(kids[1]).toMatchObject({ url: "wikilink:North%20Star", children: [{ value: "North Star" }] });
		expect(kids[3]).toMatchObject({ url: "wikilink:Proxmox%20Homelab%20Server", children: [{ value: "the server" }] });
	});

	test("headings show in the label; embeds are marked", () => {
		const tree = run({ type: "root", children: [p(t("[[Note#Closing]] ![[pic.png]]"))] });
		const kids = tree.children?.[0]?.children ?? [];
		expect(kids[0]).toMatchObject({ url: "wikilink:Note%23Closing", children: [{ value: "Note › Closing" }] });
		expect(kids[2]).toMatchObject({ url: "wikilink:pic.png", children: [{ value: "⧉ pic.png" }] });
	});

	test("code is left alone", () => {
		const tree = run({ type: "root", children: [p({ type: "inlineCode", value: "[[x]]" }), { type: "code", value: "[[y]]" }] });
		expect(tree.children?.[0]?.children?.[0]).toEqual({ type: "inlineCode", value: "[[x]]" });
	});

	test("callouts get a class and a title", () => {
		const tree = run({
			type: "root",
			children: [{ type: "blockquote", children: [p(t("[!info] State as of today\nThe body."))] }],
		});
		const quote = tree.children?.[0];
		expect(quote?.data).toMatchObject({ hName: "div", hProperties: { className: "callout callout-info" } });
		expect(quote?.children?.[0]?.children?.[0]?.value).toBe("State as of today");
		expect(quote?.children?.[1]?.children?.[0]?.value).toBe("The body.");
	});

	test("a callout without a title is titled by its kind", () => {
		const tree = run({ type: "root", children: [{ type: "blockquote", children: [p(t("[!warning]\nCareful."))] }] });
		expect(tree.children?.[0]?.children?.[0]?.children?.[0]?.value).toBe("Warning");
	});

	test("==highlights== become marks", () => {
		const tree = run({ type: "root", children: [p(t("a ==b== c"))] });
		expect(tree.children?.[0]?.children?.[1]).toMatchObject({ type: "highlight", data: { hName: "mark" } });
	});
});
