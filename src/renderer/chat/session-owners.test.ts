import { describe, expect, test } from "vitest";
import { sessionOwners } from "./session-owners.ts";

const S = "11111111-1111-4111-8111-111111111111";
const chat = (chatId: string, over: Partial<{ workspaceId: string; agent: string; sessionId: string; running: boolean }> = {}) => ({
	chatId,
	workspaceId: "w1",
	agent: "claude",
	sessionId: S,
	running: false,
	...over,
});

describe("sessionOwners", () => {
	test("idle tabs of that session are closed first", () => {
		expect(sessionOwners([chat("a"), chat("b", { sessionId: "other" })], "w1", S)).toEqual({ busy: false, idle: ["a"] });
	});

	test("a working tab blocks the delete", () => {
		expect(sessionOwners([chat("a", { running: true }), chat("b")], "w1", S).busy).toBe(true);
	});

	test("other workspaces, Antigravity chats and fresh chats without a session are not owners", () => {
		const chats = [chat("a", { workspaceId: "w2" }), chat("b", { agent: "agy" }), chat("c", { sessionId: "" })];
		expect(sessionOwners(chats, "w1", S)).toEqual({ busy: false, idle: [] });
		expect(sessionOwners([chat("c", { sessionId: "" })], "w1", "")).toEqual({ busy: false, idle: [] });
	});
});
