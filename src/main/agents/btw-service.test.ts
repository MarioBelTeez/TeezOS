import { describe, expect, test, vi } from "vitest";
import { BtwService, btwChatOf, type BtwEvent, type BtwHooks, type BtwChat } from "./btw-service.ts";

type Started = { readonly request: { readonly question: string; readonly sessionId?: string | null } & BtwHooks; readonly cancel: ReturnType<typeof vi.fn> };

function setup(chats: Record<string, BtwChat>) {
	const events: BtwEvent[] = [];
	const claude: Started[] = [];
	const agy: Started[] = [];
	let n = 0;
	const service = new BtwService({
		chat: (chatId) => chats[chatId] ?? null,
		startClaude: (request) => {
			const cancel = vi.fn();
			claude.push({ request, cancel });
			return { cancel };
		},
		startAgy: (request) => {
			const cancel = vi.fn();
			agy.push({ request, cancel });
			return { cancel };
		},
		emit: (event) => events.push(event),
		newId: () => `btw-test${(n += 1)}aa`,
	});
	return { service, events, claude, agy };
}

const claudeChat: BtwChat = { agent: "claude", cwd: "C:/v", model: "opus", sessionId: "main-1" };
const agyChat: BtwChat = { agent: "agy", cwd: "C:/v", model: "gemini", sessionId: "" };

describe("BtwService", () => {
	test("asks Claude with the chat's session and routes its events under the btw id", () => {
		const { service, events, claude } = setup({ c1: claudeChat });
		const id = service.ask("c1", "  what now?  ");
		expect(id).toBe("btw-test1aa");
		expect(claude[0]?.request).toMatchObject({ cwd: "C:/v", model: "opus", sessionId: "main-1", question: "what now?" });
		claude[0]?.request.onDelta("4");
		claude[0]?.request.onDone("42");
		expect(events).toEqual([
			{ btwId: "btw-test1aa", kind: "delta", text: "4" },
			{ btwId: "btw-test1aa", kind: "done", text: "42" },
		]);
		expect(service.running).toBe(0);
	});

	test("a chat without a session yet asks without context", () => {
		const { service, claude } = setup({ c1: { ...claudeChat, sessionId: "" } });
		service.ask("c1", "hi");
		expect(claude[0]?.request.sessionId).toBeNull();
	});

	test("Antigravity chats run a one-off agy question, which may carry the hand-over", () => {
		const { service, agy, claude } = setup({ a1: agyChat });
		const long = `${"context ".repeat(1000)}\n\nQuestion: why?`;
		expect(typeof service.ask("a1", long)).toBe("string");
		expect(agy).toHaveLength(1);
		expect(claude).toHaveLength(0);
	});

	test("refuses bad input from the window", () => {
		const { service, claude } = setup({ c1: claudeChat });
		expect(service.ask(42, "hi")).toEqual({ error: expect.any(String) });
		expect(service.ask("c1", 42)).toEqual({ error: expect.any(String) });
		expect(service.ask("c1", "   ")).toEqual({ error: expect.any(String) });
		expect(service.ask("c1", "x".repeat(4001))).toEqual({ error: expect.any(String) });
		expect(service.ask("nope", "hi")).toEqual({ error: expect.any(String) });
		expect(service.ask("x".repeat(65), "hi")).toEqual({ error: expect.any(String) });
		expect(claude).toHaveLength(0);
	});

	test("a Codex chat gets a clear answer and never runs another agent", () => {
		const { service, claude, agy } = setup({ x1: { agent: "codex", cwd: "C:/v", model: "gpt-5.5", sessionId: "" } });
		expect(service.ask("x1", "hi")).toEqual({ error: "Side questions (/btw) aren't available in Codex chats yet." });
		expect(claude).toHaveLength(0);
		expect(agy).toHaveLength(0);
	});

	test("Antigravity's limit leaves room for the hand-over, but not without end", () => {
		const { service } = setup({ a1: agyChat });
		expect(service.ask("a1", "x".repeat(12001))).toEqual({ error: expect.any(String) });
	});

	test("cancel stops the run it names and ignores anything malformed", () => {
		const { service, claude, events } = setup({ c1: claudeChat });
		const id = service.ask("c1", "hi") as string;
		service.cancel("../etc");
		service.cancel(7);
		service.cancel("btw-unknown1");
		expect(claude[0]?.cancel).not.toHaveBeenCalled();
		service.cancel(id);
		expect(claude[0]?.cancel).toHaveBeenCalledTimes(1);
		expect(service.running).toBe(0);
		// A late event from the cancelled run goes nowhere.
		claude[0]?.request.onDone("late");
		expect(events).toEqual([]);
	});

	test("caps how many side questions run at once", () => {
		const { service } = setup({ c1: claudeChat });
		for (let i = 0; i < 4; i += 1) expect(typeof service.ask("c1", `q${i}`)).toBe("string");
		expect(service.ask("c1", "one too many")).toEqual({ error: expect.any(String) });
	});

	test("a runner that cannot start is an error, not a dangling run", () => {
		const service = new BtwService({
			chat: () => claudeChat,
			startClaude: () => ({ error: "Claude Code is not installed." }),
			startAgy: () => ({ error: "x" }),
			emit: () => undefined,
		});
		expect(service.ask("c1", "hi")).toEqual({ error: "Claude Code is not installed." });
		expect(service.running).toBe(0);
	});

	test("disposeAll cancels everything still running", () => {
		const { service, claude } = setup({ c1: claudeChat });
		service.ask("c1", "a");
		service.ask("c1", "b");
		service.disposeAll();
		expect(claude.every((c) => c.cancel.mock.calls.length === 1)).toBe(true);
		expect(service.running).toBe(0);
	});

	test("ids are random and match the format cancel accepts", () => {
		const service = new BtwService({ chat: () => claudeChat, startClaude: () => ({ cancel: () => undefined }), startAgy: () => ({ cancel: () => undefined }), emit: () => undefined });
		const a = service.ask("c1", "a");
		const b = service.ask("c1", "b");
		expect(a).toMatch(/^btw-[a-z0-9]{6,20}$/);
		expect(a).not.toBe(b);
	});
	test("a runner that throws frees its slot and becomes an error", () => {
		let calls = 0;
		const service = new BtwService({
			chat: () => claudeChat,
			startClaude: () => {
				calls += 1;
				throw new Error("spawn EPERM");
			},
			startAgy: () => ({ cancel: () => undefined }),
			emit: () => undefined,
		});
		for (let i = 0; i < 5; i += 1) expect(service.ask("c1", "hi")).toEqual({ error: "spawn EPERM" });
		expect(calls).toBe(5);
		expect(service.running).toBe(0);
	});

	test("closing a chat cancels its side questions and no one else's", () => {
		const { service, claude, events } = setup({ c1: claudeChat, c2: claudeChat });
		service.ask("c1", "a");
		service.ask("c2", "b");
		service.cancelChat("c1");
		expect(claude[0]?.cancel).toHaveBeenCalledTimes(1);
		expect(claude[1]?.cancel).not.toHaveBeenCalled();
		expect(service.running).toBe(1);
		claude[0]?.request.onDone("late");
		expect(events).toEqual([]);
	});
});

describe("btwChatOf", () => {
	const registry = (sessionId: string, resume?: string) => ({
		options: (chatId: string) =>
			chatId === "c1" ? { workspaceId: "w", cwd: "C:/v", agent: "claude" as const, model: "sonnet", permission: "auto", effort: "", ...(resume ? { resume } : {}) } : undefined,
		sessionId: () => sessionId,
	});

	test("uses the live session id, and the chat's current model", () => {
		expect(btwChatOf(registry("live-1", "old-1"), "c1")).toEqual({ agent: "claude", cwd: "C:/v", model: "sonnet", sessionId: "live-1" });
	});

	test("a resumed chat that has not reported its session yet asks with the one it resumed", () => {
		expect(btwChatOf(registry("", "old-1"), "c1")?.sessionId).toBe("old-1");
	});

	test("a new chat with no session asks without one; an unknown chat is null", () => {
		expect(btwChatOf(registry(""), "c1")?.sessionId).toBe("");
		expect(btwChatOf(registry(""), "nope")).toBeNull();
	});
});
