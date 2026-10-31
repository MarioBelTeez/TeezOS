import { describe, expect, test } from "vitest";
import { filterHistory, mergeHistory, type VaultSource } from "./feed-history.ts";
import type { FeedItem } from "./feed.ts";

const base: FeedItem = {
	id: "a",
	source: "https://youtu.be/1",
	input: "video",
	kind: "auto",
	note: "",
	status: "done",
	createdAt: 1000,
	startedAt: 1000,
	finishedAt: 2000,
	title: "How hooks work",
	log: [],
	changed: ["reference/sources/How hooks work.md", "brain/concepts/Hooks.md"],
	drafts: [],
	error: null,
};
const item = (over: Partial<FeedItem>): FeedItem => ({ ...base, ...over });
const vaultNote = (over: Partial<VaultSource> = {}): VaultSource => ({
	path: "reference/sources/Old talk.md",
	title: "Old talk",
	date: 500,
	url: "https://example.com/old",
	kind: "article",
	...over,
});

describe("mergeHistory", () => {
	test("lists finished items newest first, with date, title, source, kind and the notes created", () => {
		const entries = mergeHistory(
			[item({ id: "a", finishedAt: 2000 }), item({ id: "b", title: "", source: "https://example.com/post", input: "article", finishedAt: 3000, changed: ["reference/sources/Post.md"] })],
			[],
		);
		expect(entries.map((e) => e.itemId)).toEqual(["b", "a"]);
		expect(entries[1]).toMatchObject({ date: 2000, title: "How hooks work", source: "https://youtu.be/1", kind: "video", notes: base.changed });
		expect(entries[0]).toMatchObject({ title: "https://example.com/post", kind: "article" });
	});

	test("skips jobs that did not finish", () => {
		const entries = mergeHistory([item({ id: "q", status: "queued" }), item({ id: "f", status: "failed" }), item({ id: "c", status: "cancelled" }), item({ id: "r", status: "reading" })], []);
		expect(entries).toEqual([]);
	});

	test("a local video file is a video; a pdf is a pdf", () => {
		const entries = mergeHistory([item({ id: "v", input: "video-file", source: "C:\\v\\a.mp4" }), item({ id: "p", input: "pdf", source: "C:\\d\\a.pdf" })], []);
		expect(entries.map((e) => e.kind).sort()).toEqual(["pdf", "video"]);
	});

	test("adds vault notes that no job lists, and not the ones a job already lists", () => {
		const entries = mergeHistory([item({})], [vaultNote(), vaultNote({ path: "reference/sources/How hooks work.md", title: "How hooks work", date: 2100 })]);
		expect(entries.map((e) => e.title)).toEqual(["How hooks work", "Old talk"]);
		const old = entries.find((e) => e.itemId === null);
		expect(old).toMatchObject({ notes: ["reference/sources/Old talk.md"], source: "https://example.com/old", kind: "article", date: 500 });
	});

	test("path comparison ignores case and slash direction", () => {
		const entries = mergeHistory([item({ changed: ["Reference\\Sources\\Old Talk.md"] })], [vaultNote()]);
		expect(entries).toHaveLength(1);
	});

	test("orders items and vault notes together by date, newest first", () => {
		const entries = mergeHistory([item({ id: "a", finishedAt: 2000 })], [vaultNote({ date: 3000, title: "Newest", path: "reference/sources/Newest.md" }), vaultNote({ date: 1500 })]);
		expect(entries.map((e) => e.title)).toEqual(["Newest", "How hooks work", "Old talk"]);
	});

	test("keeps at most 200 persisted items", () => {
		const many = Array.from({ length: 230 }, (_, i) => item({ id: `i${i}`, finishedAt: i, changed: [`reference/sources/n${i}.md`] }));
		expect(mergeHistory(many, [])).toHaveLength(200);
		expect(mergeHistory(many, [])[0]?.itemId).toBe("i229");
	});

	test("every entry has a distinct key", () => {
		const entries = mergeHistory([item({ id: "a" }), item({ id: "b", changed: [] })], [vaultNote()]);
		expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
	});
});

describe("filterHistory", () => {
	const entries = mergeHistory(
		[item({ id: "a", finishedAt: Date.UTC(2026, 9, 15, 12) }), item({ id: "b", title: "Prompt caching deep dive", source: "https://example.com/cache", input: "article", finishedAt: 5, changed: ["reference/sources/Prompt caching deep dive.md"] })],
		[],
	);

	test("an empty query keeps everything", () => {
		expect(filterHistory(entries, "  ")).toEqual(entries);
	});

	test("matches title, source, kind, notes and date; case-insensitively", () => {
		expect(filterHistory(entries, "HOOKS").map((e) => e.itemId)).toEqual(["a"]);
		expect(filterHistory(entries, "example.com").map((e) => e.itemId)).toEqual(["b"]);
		expect(filterHistory(entries, "article").map((e) => e.itemId)).toEqual(["b"]);
		expect(filterHistory(entries, "concepts/hooks").map((e) => e.itemId)).toEqual(["a"]);
		expect(filterHistory(entries, "2026-10-15").map((e) => e.itemId)).toEqual(["a"]);
	});

	test("every word has to match", () => {
		expect(filterHistory(entries, "prompt deep").map((e) => e.itemId)).toEqual(["b"]);
		expect(filterHistory(entries, "prompt hooks")).toEqual([]);
	});
});
