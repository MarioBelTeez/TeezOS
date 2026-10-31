import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatStore, type StoredChat } from "./chat-store.ts";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "phone-chats-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const chat = (id: string, updatedAt: number, title = "t"): StoredChat => ({
	id,
	title,
	engine: "agy",
	effort: "medium",
	conversationId: "",
	cards: [{ id: "c1", kind: "user", text: "hi" }],
	createdAt: 1,
	updatedAt,
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("ChatStore", () => {
	it("persists and lists chats newest first", async () => {
		const store = new ChatStore(dir);
		store.save(chat(A, 10, "older"));
		store.save(chat(B, 20, "newer"));
		const reopened = new ChatStore(dir);
		expect(reopened.list().map((c) => c.title)).toEqual(["newer", "older"]);
		expect(reopened.list()[0]).toEqual({ id: B, title: "newer", engine: "agy", createdAt: 1, updatedAt: 20 });
		expect(reopened.get(A)?.cards).toEqual([{ id: "c1", kind: "user", text: "hi" }]);
		// Written through a temp file: nothing else is left behind.
		expect((await readdir(path.join(dir, "chats"))).sort()).toEqual([`${A}.json`, `${B}.json`]);
	});

	it("refuses ids that are not UUIDs and skips corrupt files", async () => {
		const store = new ChatStore(dir);
		expect(store.get("../captures")).toBeNull();
		expect(() => store.save(chat("../x", 1))).toThrow();
		store.save(chat(A, 1));
		await writeFile(path.join(dir, "chats", `${B}.json`), "{nope");
		const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(store.list().map((c) => c.id)).toEqual([A]);
		expect(store.get(B)).toBeNull();
		expect(quiet).toHaveBeenCalled();
		quiet.mockRestore();
	});
});
