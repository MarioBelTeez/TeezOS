import { describe, expect, test, vi } from "vitest";
import { ChatRegistry, type AgentSession, type ChatEnvelope, type ApprovalEnvelope } from "./registry.ts";

function fakeSession(): AgentSession & { sent: string[]; disposed: boolean } {
	return {
		sent: [] as string[],
		disposed: false,
		sessionId: "session-1",
		send(text: string) {
			this.sent.push(text);
		},
		stop: vi.fn(() => Promise.resolve()),
		respondToApproval: vi.fn(),
		setModel: vi.fn(() => Promise.resolve()),
		setPermissionMode: vi.fn(() => Promise.resolve()),
		setEffort: vi.fn(() => Promise.resolve()),
		commands: vi.fn(() => Promise.resolve([{ name: "review", description: "Review a PR", argumentHint: "<pr>" }])),
		dispose() {
			this.disposed = true;
		},
	};
}

const options = {
	workspaceId: "ws1",
	cwd: "C:\\ws1",
	agent: "claude" as const,
	model: "",
	permission: "default",
	effort: "",
};

describe("ChatRegistry", () => {
	test("routes a session's events and approvals under the chat id", () => {
		const events: ChatEnvelope[] = [];
		const approvals: ApprovalEnvelope[] = [];
		let callbacks: Parameters<ConstructorParameters<typeof ChatRegistry>[0]>[1] | undefined;
		const registry = new ChatRegistry(
			(_options, cb) => {
				callbacks = cb;
				return fakeSession();
			},
			{ event: (e) => events.push(e), approval: (a) => approvals.push(a) },
			() => "chat-1",
		);

		const chatId = registry.create(options);
		callbacks?.onEvent({ kind: "text-delta", sessionId: "s", text: "hi" });
		callbacks?.onApproval({ id: "a1", toolName: "Write", input: {} });

		expect(chatId).toBe("chat-1");
		expect(events).toEqual([
			{ chatId: "chat-1", event: { kind: "text-delta", sessionId: "s", text: "hi" } },
		]);
		expect(approvals).toEqual([
			{ chatId: "chat-1", request: { id: "a1", toolName: "Write", input: {} } },
		]);
	});

	test("a session that cannot start becomes the chat's first error", () => {
		const events: ChatEnvelope[] = [];
		const registry = new ChatRegistry(
			() => ({ error: "Claude Code is not installed.", reason: "claude-not-found" }),
			{ event: (e) => events.push(e), approval: () => undefined },
			() => "chat-x",
		);
		registry.create(options);
		expect(events[0]?.event).toMatchObject({ kind: "run-error", reason: "claude-not-found" });
		expect(registry.has("chat-x")).toBe(false);
	});

	test("send and close reach the right session, unknown chats are ignored", () => {
		const sessions: ReturnType<typeof fakeSession>[] = [];
		let n = 0;
		const registry = new ChatRegistry(
			() => {
				const s = fakeSession();
				sessions.push(s);
				return s;
			},
			{ event: () => undefined, approval: () => undefined },
			() => `c${(n += 1)}`,
		);
		const a = registry.create(options);
		const b = registry.create({ ...options, workspaceId: "ws2" });

		expect(registry.send(b, "hello")).toBe(true);
		expect(registry.send("nope", "x")).toBe(false);
		expect(sessions[1]?.sent).toEqual(["hello"]);

		registry.closeWorkspace("ws1");
		expect(sessions[0]?.disposed).toBe(true);
		expect(registry.has(a)).toBe(false);
		expect(registry.has(b)).toBe(true);

		registry.disposeAll();
		expect(sessions[1]?.disposed).toBe(true);
	});

	test("lists a chat's slash commands, and none for a chat that is gone", async () => {
		const registry = new ChatRegistry(() => fakeSession(), { event: () => undefined, approval: () => undefined }, () => "chat-1");
		registry.create(options);
		expect(await registry.commands("chat-1")).toEqual([{ name: "review", description: "Review a PR", argumentHint: "<pr>" }]);
		expect(await registry.commands("nope")).toEqual([]);
	});

	test("knows a chat's agent session id, and none for a chat that is gone", () => {
		const registry = new ChatRegistry(() => fakeSession(), { event: () => undefined, approval: () => undefined }, () => "chat-1");
		registry.create(options);
		expect(registry.sessionId("chat-1")).toBe("session-1");
		expect(registry.sessionId("nope")).toBe("");
	});
	test("a model switch is remembered in the chat's options", async () => {
		const registry = new ChatRegistry(() => fakeSession(), { event: () => undefined, approval: () => undefined }, () => "chat-1");
		registry.create({ ...options, model: "opus" });
		const before = registry.options("chat-1");
		await registry.setModel("chat-1", "sonnet");
		expect(registry.options("chat-1")).toMatchObject({ model: "sonnet", workspaceId: "ws1" });
		// Replaced, not changed in place.
		expect(before?.model).toBe("opus");
		await registry.setModel("nope", "sonnet");
		expect(registry.has("nope")).toBe(false);
	});

	test("tells its listeners about every chat it closes, however it is closed", () => {
		let n = 0;
		const registry = new ChatRegistry(() => fakeSession(), { event: () => undefined, approval: () => undefined }, () => `c${(n += 1)}`);
		const closed: string[] = [];
		const off = registry.onClose((chatId) => closed.push(chatId));
		registry.create(options);
		registry.create({ ...options, workspaceId: "ws2" });
		registry.create(options);
		registry.close("c1");
		registry.closeWorkspace("ws2");
		registry.close("nope");
		off();
		registry.disposeAll();
		expect(closed).toEqual(["c1", "c2"]);
	});
});

describe("ChatRegistry — plan usage", () => {
	const usage = (pct: number) => ({ fiveHour: { pct, resetsAt: null }, weekly: null, weeklyOpus: null, weeklySonnet: null, models: [] });

	function setup(answers: Record<string, ReturnType<typeof usage> | null | "no-method">) {
		const asked: string[] = [];
		let n = 0;
		const registry = new ChatRegistry(
			(opts) => {
				const name = `c${(n += 1)}`;
				const session = fakeSession();
				const answer = answers[name];
				if (answer === "no-method") return session;
				return Object.assign(session, {
					usage: () => {
						asked.push(name);
						return Promise.resolve(opts.agent === "claude" ? (answer ?? null) : usage(99));
					},
				});
			},
			{ event: () => undefined, approval: () => undefined },
			() => `c${n + 1}`,
		);
		return { registry, asked };
	}

	test("null with no chat open", async () => {
		expect(await setup({}).registry.usage()).toBeNull();
	});

	test("asks the most recently active Claude chat first", async () => {
		const { registry, asked } = setup({ c1: usage(10), c2: usage(20) });
		registry.create(options);
		registry.create(options);
		registry.send("c1", "hi");
		expect(await registry.usage()).toEqual(usage(10));
		expect(asked).toEqual(["c1"]);
	});

	test("falls back to the next Claude chat when one cannot answer (not started yet)", async () => {
		const { registry, asked } = setup({ c1: usage(10), c2: null });
		registry.create(options);
		registry.create(options);
		expect(await registry.usage()).toEqual(usage(10));
		expect(asked).toEqual(["c2", "c1"]);
	});

	test("never asks an Antigravity chat, nor a session without the method", async () => {
		const { registry, asked } = setup({ c1: "no-method" });
		registry.create(options);
		registry.create({ ...options, agent: "agy" });
		expect(await registry.usage()).toBeNull();
		expect(asked).toEqual([]);
	});

	test("a closed chat is no longer asked", async () => {
		const { registry, asked } = setup({ c1: usage(10) });
		registry.create(options);
		registry.close("c1");
		expect(await registry.usage()).toBeNull();
		expect(asked).toEqual([]);
	});

	test("an effort change reaches the session and the chat's options", async () => {
		const session = fakeSession();
		const registry = new ChatRegistry(() => session, { event: () => undefined, approval: () => undefined });
		const chatId = registry.create(options);
		await registry.setEffort(chatId, "max");
		expect(session.setEffort).toHaveBeenCalledWith("max");
		expect(registry.options(chatId)?.effort).toBe("max");
	});
});
