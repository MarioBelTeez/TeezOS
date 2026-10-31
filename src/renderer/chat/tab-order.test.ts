import { describe, expect, test } from "vitest";
import { chatToEvict, moveTab, orderedTabs } from "./tab-order.ts";

describe("chatToEvict", () => {
	const chat = (chatId: string, createdAt: number, running = false) => ({ chatId, createdAt, running });
	const full = Array.from({ length: 12 }, (_, i) => chat(`c${i}`, i));

	test("room left: nothing to close", () => {
		expect(chatToEvict(full.slice(0, 11), undefined, 12)).toBeNull();
	});

	test("at the cap: the oldest idle chat", () => {
		expect(chatToEvict(full, undefined, 12)?.chatId).toBe("c0");
	});

	test("never a running chat, never the one being left", () => {
		const chats = [chat("c0", 0, true), chat("c1", 1), ...full.slice(2)];
		expect(chatToEvict(chats, "c1", 12)?.chatId).toBe("c2");
	});

	test("every candidate running or kept: nothing to close", () => {
		const chats = full.map((c) => ({ ...c, running: c.chatId !== "c5" }));
		expect(chatToEvict(chats, "c5", 12)).toBeNull();
	});
});

describe("moveTab", () => {
	test("drops before the target", () => {
		expect(moveTab(["a", "b", "c", "d"], "d", "b", false)).toEqual(["a", "d", "b", "c"]);
	});

	test("drops after the target", () => {
		expect(moveTab(["a", "b", "c", "d"], "a", "c", true)).toEqual(["b", "c", "a", "d"]);
	});

	test("to the very end and the very start", () => {
		expect(moveTab(["a", "b", "c"], "a", "c", true)).toEqual(["b", "c", "a"]);
		expect(moveTab(["a", "b", "c"], "c", "a", false)).toEqual(["c", "a", "b"]);
	});

	test("onto itself, or with an unknown id, nothing moves", () => {
		const order = ["a", "b"];
		expect(moveTab(order, "a", "a", true)).toBe(order);
		expect(moveTab(order, "x", "a", true)).toBe(order);
		expect(moveTab(order, "a", "x", true)).toBe(order);
	});

	test("does not change the order it was given", () => {
		const order = ["a", "b", "c"];
		moveTab(order, "a", "c", true);
		expect(order).toEqual(["a", "b", "c"]);
	});
});

describe("orderedTabs", () => {
	const chat = (chatId: string, createdAt: number) => ({ chatId, createdAt });

	test("follows the explicit order", () => {
		expect(orderedTabs([chat("a", 1), chat("b", 2), chat("c", 3)], ["c", "a", "b"]).map((c) => c.chatId)).toEqual(["c", "a", "b"]);
	});

	test("chats missing from the order follow it, oldest first; stale ids are ignored", () => {
		expect(orderedTabs([chat("a", 1), chat("c", 3), chat("b", 2)], ["gone", "a"]).map((c) => c.chatId)).toEqual(["a", "b", "c"]);
	});
});
