import { describe, expect, test } from "vitest";
import type { ApiResult } from "./api.ts";
import { createDraft, memoryStorage } from "./draft.ts";

const ok: ApiResult<unknown> = { ok: true, data: {} };
const failed: ApiResult<unknown> = { ok: false, error: "You are offline.", offline: true };

describe("draft", () => {
	test("keeps the draft when the send fails", async () => {
		const draft = createDraft(memoryStorage(), "chat");
		draft.set("remember the router password moved");
		const result = await draft.send(async () => failed);
		expect(result.ok).toBe(false);
		expect(draft.text()).toBe("remember the router password moved");
	});

	test("keeps the draft while the send is in flight and clears it once the API returns ok", async () => {
		const draft = createDraft(memoryStorage(), "chat");
		draft.set("hello");
		let seenDuring = "";
		let sent = "";
		await draft.send(async (text) => {
			seenDuring = draft.text();
			sent = text;
			return ok;
		});
		expect(sent).toBe("hello");
		expect(seenDuring).toBe("hello");
		expect(draft.text()).toBe("");
	});

	test("keeps what was typed while the send was in flight", async () => {
		const draft = createDraft(memoryStorage(), "chat");
		draft.set("first");
		await draft.send(async () => {
			draft.set("first and more");
			return ok;
		});
		expect(draft.text()).toBe("first and more");
	});

	test("does not send an empty draft", async () => {
		const draft = createDraft(memoryStorage(), "chat");
		draft.set("   ");
		let called = false;
		const result = await draft.send(async () => {
			called = true;
			return ok;
		});
		expect(called).toBe(false);
		expect(result.ok).toBe(false);
	});

	test("a send that throws keeps the draft", async () => {
		const draft = createDraft(memoryStorage(), "chat");
		draft.set("keep me");
		const result = await draft.send(async () => {
			throw new Error("boom");
		});
		expect(result.ok).toBe(false);
		expect(draft.text()).toBe("keep me");
	});

	test("survives a reload through its storage", () => {
		const storage = memoryStorage();
		createDraft(storage, "chat").set("half a thought");
		expect(createDraft(storage, "chat").text()).toBe("half a thought");
	});
});
