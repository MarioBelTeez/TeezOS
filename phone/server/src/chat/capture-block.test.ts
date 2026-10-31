import { describe, expect, it } from "vitest";
import { CaptureStreamFilter, parseCaptureBlocks } from "./capture-block.ts";

describe("parseCaptureBlocks", () => {
	it("strips capture blocks from the shown text and returns them", () => {
		const reply = 'Got it, noted.\n\n<teez-capture links="Groceries|Home">Buy oat milk on Friday.</teez-capture>';
		const parsed = parseCaptureBlocks(reply);
		expect(parsed.text).toBe("Got it, noted.");
		expect(parsed.captures).toEqual([{ text: "Buy oat milk on Friday.", links: ["Groceries", "Home"] }]);
	});

	it("ignores a path in a capture block", () => {
		const parsed = parseCaptureBlocks('<teez-capture path="../CLAUDE.md">x</teez-capture>');
		expect(parsed.captures).toEqual([{ text: "x", links: [] }]);
		expect(Object.keys(parsed.captures[0]!)).toEqual(["text", "links"]);

		const huge = parseCaptureBlocks(`<teez-capture file="a.md">${"y".repeat(1_000_000)}</teez-capture>`);
		expect(huge.captures[0]!.text).toHaveLength(4000);
	});

	it("keeps at most five", () => {
		const reply = Array.from({ length: 8 }, (_, i) => `<teez-capture>item ${i}</teez-capture>`).join(" ");
		const parsed = parseCaptureBlocks(reply);
		expect(parsed.captures.map((c) => c.text)).toEqual(["item 0", "item 1", "item 2", "item 3", "item 4"]);
		expect(parsed.text).toBe("");
	});

	it("sanitises links into plain note titles", () => {
		const links = ["[[Evil]]|Note#Head", "x^block", "a\nb", "   ", ...Array.from({ length: 12 }, (_, i) => `N${i}`)].join("|");
		const parsed = parseCaptureBlocks(`<teez-capture links="${links}">t</teez-capture>`);
		const out = parsed.captures[0]!.links;
		expect(out.slice(0, 4)).toEqual(["Evil", "NoteHead", "xblock", "ab"]);
		expect(out).toHaveLength(10);
		expect(out.every((l) => !/[[\]|#^\n]/.test(l))).toBe(true);
		const long = parseCaptureBlocks(`<teez-capture links="${"z".repeat(500)}">t</teez-capture>`);
		expect(long.captures[0]!.links[0]).toHaveLength(120);
	});

	it("drops empty blocks and hides an unclosed one, as the stream does", () => {
		expect(parseCaptureBlocks("a <teez-capture>  </teez-capture> b").captures).toEqual([]);
		expect(parseCaptureBlocks("a <teez-capture>half")).toEqual({ text: "a", captures: [] });
	});
});

describe("CaptureStreamFilter", () => {
	it("holds back capture blocks split across deltas", () => {
		const filter = new CaptureStreamFilter();
		const parts = ["Noted. <te", "ez-capture links=\"A\">remember ", "this</teez-", "capture> done", "!"];
		const shown = parts.map((p) => filter.push(p)).join("") + filter.flush();
		expect(shown).toBe("Noted.  done!");
	});

	it("passes a lone < through once it cannot be a capture tag", () => {
		const filter = new CaptureStreamFilter();
		expect(filter.push("a <")).toBe("a ");
		expect(filter.push("b")).toBe("<b");
		expect(filter.flush()).toBe("");
	});
});
