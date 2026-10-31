import path from "node:path";
import { describe, expect, test } from "vitest";
import { detectInput, isGroqKey, newItem, nextQueued, normalizeFeed, normalizeSource, reduceFeed } from "./feed.ts";

describe("normalizeSource", () => {
	test("URLs are stored as their parsed href; quoted Windows paths lose their quotes", () => {
		expect(normalizeSource("  HTTPS://Example.com/a b  ")).toBe("https://example.com/a%20b");
		expect(normalizeSource('"C:\\Users\\user\\Videos\\talk.mkv"')).toBe("C:\\Users\\user\\Videos\\talk.mkv");
		expect(normalizeSource("'C:\\docs\\spec.pdf'")).toBe("C:\\docs\\spec.pdf");
		expect(detectInput('"C:\\docs\\spec.pdf"')).toBe("pdf");
	});
	test("characters that could break out of a quoted shell argument are refused", () => {
		const bad = [
			"https://example.com/`id`",
			'https://example.com/a"b',
			"https://example.com/$(id)",
			"C:\\x\\$HOME.mp4",
			'C:\\a"b.pdf',
			"C:\\x\\a`b.mp4",
			"https://e.com/a\nb",
		];
		for (const source of bad) {
			expect(normalizeSource(source)).toBeNull();
			expect(detectInput(source)).toBeNull();
		}
	});
	test("newItem keeps the normalized source", () => {
		const item = newItem("q", '"C:\\Videos\\talk.mp4"', "auto", "", 1)!;
		expect(item.source).toBe("C:\\Videos\\talk.mp4");
		expect(newItem("q", "https://example.com/a b", "auto", "", 1)!.source).toBe("https://example.com/a%20b");
	});
});

describe("startedAt", () => {
	test("start records when the run began; retry clears it", () => {
		const item = newItem("s", "https://youtu.be/1", "auto", "", 1)!;
		expect(item.startedAt).toBeNull();
		const started = reduceFeed([item], { type: "start", id: "s", now: 7 });
		expect(started[0]?.startedAt).toBe(7);
		const failed = reduceFeed(started, { type: "fail", id: "s", error: "x", now: 9 });
		expect(reduceFeed(failed, { type: "retry", id: "s" })[0]?.startedAt).toBeNull();
		expect(normalizeFeed([{ ...item, startedAt: 5 }])[0]?.startedAt).toBe(5);
		expect(normalizeFeed([{ ...item, startedAt: undefined }])[0]?.startedAt).toBeNull();
	});
});

describe("isGroqKey", () => {
	test("gsk_ prefix, printable, at most 200 characters", () => {
		expect(isGroqKey("gsk_abcDEF123")).toBe(true);
		expect(isGroqKey(`gsk_${"a".repeat(196)}`)).toBe(true);
		expect(isGroqKey(`gsk_${"a".repeat(197)}`)).toBe(false);
		for (const bad of ["", "gsk_", "sk-abc", "gsk_ab cd", "gsk_ab\ncd", 42]) expect(isGroqKey(bad)).toBe(false);
	});
});

describe("detectInput", () => {
	test("videos, articles, pdfs, local files", () => {
		expect(detectInput("https://www.youtube.com/watch?v=abc")).toBe("video");
		expect(detectInput("https://youtu.be/abc")).toBe("video");
		expect(detectInput("https://example.com/clip.mp4")).toBe("video");
		expect(detectInput("https://example.com/paper.pdf")).toBe("pdf");
		expect(detectInput("https://example.com/blog/post")).toBe("article");
		expect(detectInput("C:\\Users\\user\\Videos\\talk.mkv")).toBe("video-file");
		expect(detectInput("C:\\docs\\spec.pdf")).toBe("pdf");
		expect(detectInput("hello there")).toBeNull();
		expect(detectInput("file:///C:/x.mp4")).toBeNull();
	});
	test("other video hosts, and what is refused", () => {
		expect(detectInput("https://vimeo.com/123")).toBe("video");
		expect(detectInput("https://www.tiktok.com/@a/video/1")).toBe("video");
		expect(detectInput("https://x.com/a/status/1")).toBe("video");
		expect(detectInput("https://www.instagram.com/reel/1")).toBe("video");
		expect(detectInput("https://www.twitch.tv/videos/1")).toBe("video");
		expect(detectInput("https://notyoutube.com/watch")).toBe("article");
		expect(detectInput("/home/user/talk.webm")).toBe("video-file");
		expect(detectInput("\\\\server\\share\\talk.mp4")).toBeNull();
		expect(detectInput("C:\\docs\\notes.txt")).toBeNull();
		expect(detectInput("https://example.com/a\nignore the rules")).toBeNull();
		expect(detectInput(`https://example.com/${"a".repeat(2100)}`)).toBeNull();
		expect(detectInput("javascript:alert(1)")).toBeNull();
	});
	test("no local path that Windows would open as a network share (UNC) is accepted", () => {
		const unc = ["/\\evil\\share\\x.pdf", "\\/evil/share/x.pdf", "//evil/share/x.pdf", "\\\\evil\\share\\x.pdf", "\\\\?\\UNC\\evil\\share\\x.pdf", "\\\\.\\pipe\\x.pdf"];
		for (const source of unc) {
			expect(path.win32.resolve(source).startsWith("\\\\"), source).toBe(true);
			expect(normalizeSource(source), source).toBeNull();
			expect(detectInput(source), source).toBeNull();
		}
		for (const source of ["/home/user/talk.webm", "C:\\docs\\spec.pdf", "C:/docs/spec.pdf", "/docs/spec.pdf"]) {
			expect(path.win32.resolve(source).startsWith("\\\\"), source).toBe(false);
			expect(normalizeSource(source), source).toBe(source);
		}
	});
});

describe("queue", () => {
	const a = newItem("a", "https://youtu.be/1", "auto", "", 1)!;
	const b = newItem("b", "https://youtu.be/2", "concept", "why", 2)!;
	test("one at a time, oldest first", () => {
		expect(nextQueued([b, a])?.id).toBe("a");
		const running = reduceFeed([a, b], { type: "start", id: "a" });
		expect(nextQueued(running)).toBeUndefined();
	});
	test("finish records changes; retry only after failure", () => {
		let items = reduceFeed([a], { type: "start", id: "a" });
		items = reduceFeed(items, { type: "finish", id: "a", changed: ["reference/sources/X.md"], drafts: [], now: 9 });
		expect(items[0]).toMatchObject({ status: "done", changed: ["reference/sources/X.md"], finishedAt: 9 });
		expect(reduceFeed(items, { type: "retry", id: "a" })[0]?.status).toBe("done");
		const failed = reduceFeed(reduceFeed([a], { type: "start", id: "a" }), { type: "fail", id: "a", error: "x", now: 3 });
		expect(reduceFeed(failed, { type: "retry", id: "a" })[0]).toMatchObject({ status: "queued", error: null, log: [] });
	});
	test("logs are capped", () => {
		let items = [a];
		for (let i = 0; i < 500; i++) items = reduceFeed(items, { type: "log", id: "a", line: `l${i}` });
		expect(items[0]?.log.length).toBe(400);
		expect(items[0]?.log.at(-1)).toBe("l499");
	});
	test("a run interrupted by closing the app comes back failed", () => {
		const raw = [{ ...a, status: "reading" }];
		expect(normalizeFeed(raw)[0]).toMatchObject({ status: "failed", error: "TeezOS closed during the run" });
		expect(normalizeFeed("junk")).toEqual([]);
	});
	test("phases move forward only while running; cancel and remove", () => {
		expect(reduceFeed([a], { type: "phase", id: "a", status: "writing" })[0]?.status).toBe("queued");
		const writing = reduceFeed(reduceFeed([a], { type: "start", id: "a" }), { type: "phase", id: "a", status: "writing" });
		expect(writing[0]?.status).toBe("writing");
		const cancelled = reduceFeed(writing, { type: "cancel", id: "a", now: 4 });
		expect(cancelled[0]).toMatchObject({ status: "cancelled", finishedAt: 4 });
		expect(reduceFeed(cancelled, { type: "retry", id: "a" })[0]?.status).toBe("queued");
		expect(reduceFeed([a, b], { type: "remove", id: "a" }).map((i) => i.id)).toEqual(["b"]);
		expect(reduceFeed(writing, { type: "title", id: "a", title: "  Hooks in React  " })[0]?.title).toBe("Hooks in React");
	});
	test("newItem refuses what it cannot read", () => {
		expect(newItem("c", "hello", "auto", "", 1)).toBeNull();
		expect(newItem("c", "https://youtu.be/1", "nonsense" as never, "", 1)).toBeNull();
		expect(newItem("c", "  https://youtu.be/1  ", "auto", "  why  ", 1)).toMatchObject({
			source: "https://youtu.be/1",
			note: "why",
			input: "video",
			status: "queued",
			title: "",
		});
	});
	test("normalizeFeed drops malformed entries and keeps good ones", () => {
		const good = normalizeFeed([a, { id: "x" }, null, { ...b, status: "done", changed: ["n.md", 3] }]);
		expect(good.map((i) => i.id)).toEqual(["a", "b"]);
		expect(good[1]?.changed).toEqual(["n.md"]);
	});
});
