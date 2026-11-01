import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { UiEvent } from "../claude/events.ts";
import type { ApprovalRequest } from "../claude/service.ts";
import type { ChildLike } from "../agy/session.ts";
import { CodexSession, codexPolicy, type CodexSessionDeps } from "./session.ts";

type Written = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown };

/** A stand-in for `codex app-server`: answers the handshake, thread and turn requests, records everything written to it. */
class FakeCodex extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = 77;
	readonly written: Written[] = [];
	kill = vi.fn();
	#turns = 0;
	constructor(readonly threadId = "thread-1") {
		super();
		let buffer = "";
		this.stdin.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let i;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const message = JSON.parse(buffer.slice(0, i)) as Written;
				buffer = buffer.slice(i + 1);
				this.written.push(message);
				this.#answer(message);
			}
		});
	}
	/** When set, turn/start is not answered until `releaseTurnStart()`: a turn whose id has not arrived yet. */
	holdTurnStart = false;
	#held: Written | null = null;
	releaseTurnStart(): void {
		const held = this.#held;
		this.#held = null;
		this.holdTurnStart = false;
		if (held) this.#answer(held);
	}
	#answer(m: Written): void {
		if (m.id === undefined || !m.method) return;
		if (m.method === "turn/start" && this.holdTurnStart) {
			this.#held = m;
			return;
		}
		const result =
			m.method === "initialize" ? { userAgent: "codex" }
			: m.method === "thread/start" || m.method === "thread/resume" ? { thread: { id: this.threadId } }
			: m.method === "turn/start" ? { turn: { id: `turn-${(this.#turns += 1)}` } }
			: {};
		this.send({ id: m.id, result });
	}
	send(message: unknown): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}
	requests(method: string): Written[] {
		return this.written.filter((w) => w.method === method);
	}
	answerTo(id: number | string): Written | undefined {
		return this.written.find((w) => w.id === id && w.method === undefined);
	}
}

const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function setup(overrides: Partial<CodexSessionDeps> = {}) {
	const children: FakeCodex[] = [];
	const events: UiEvent[] = [];
	const approvals: ApprovalRequest[] = [];
	const spawn = vi.fn((_file: string, _args: readonly string[], _options: { readonly cwd: string }) => {
		const child = new FakeCodex();
		children.push(child);
		return child as unknown as ChildLike;
	});
	const session = new CodexSession({
		codexPath: "C:/codex/codex.exe",
		cwd: "C:/work/site",
		model: "gpt-5.5",
		permission: "ask",
		effort: "medium",
		onEvent: (event) => events.push(event),
		onApproval: (request) => approvals.push(request),
		spawn,
		killTree: (child) => void child.kill(),
		...overrides,
	});
	return { session, spawn, children, events, approvals, child: () => children[children.length - 1]! };
}

const turnDone = (child: FakeCodex, status = "completed") =>
	child.send({ method: "turn/completed", params: { threadId: child.threadId, turn: { id: "turn-1", status, items: [] } } });

describe("codexPolicy", () => {
	test("each mode maps to an approval policy and a sandbox; unknown modes ask", () => {
		expect(codexPolicy("ask")).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
		expect(codexPolicy("auto-edit")).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
		expect(codexPolicy("full-access")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
		expect(codexPolicy("nonsense")).toEqual(codexPolicy("ask"));
	});
});

describe("CodexSession", () => {
	test("the first message starts app-server, opens a thread with the mode's policy, then a turn", async () => {
		const { session, spawn, child } = setup();
		session.send("hi");
		await flush();
		expect(spawn).toHaveBeenCalledWith("C:/codex/codex.exe", ["app-server"], { cwd: "C:/work/site" });
		const c = child();
		expect(c.written.map((w) => w.method ?? "answer")).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
		expect(c.requests("thread/start")[0]!.params).toMatchObject({ cwd: "C:/work/site", model: "gpt-5.5", approvalPolicy: "untrusted", sandbox: "workspace-write" });
		expect(c.requests("turn/start")[0]!.params).toMatchObject({
			threadId: "thread-1",
			input: [{ type: "text", text: "hi", text_elements: [] }],
			model: "gpt-5.5",
			effort: "medium",
			approvalPolicy: "untrusted",
		});
		expect(session.sessionId).toBe("thread-1");
	});

	test("notifications become chat events", async () => {
		const { session, child, events } = setup();
		session.send("hi");
		await flush();
		child().send({ method: "item/agentMessage/delta", params: { itemId: "m", delta: "hel" } });
		await flush();
		expect(events).toContainEqual({ kind: "text-delta", sessionId: "thread-1", text: "hel" });
	});

	test("a command approval becomes one card; allow answers accept, deny answers decline", async () => {
		const { session, child, approvals } = setup();
		session.send("run it");
		await flush();
		child().send({ id: 90, method: "item/commandExecution/requestApproval", params: { itemId: "c1", command: "echo hi > a.txt", cwd: "C:/work/site" } });
		await flush();
		expect(approvals).toEqual([{ id: expect.any(String), toolName: "Bash", input: { command: "echo hi > a.txt", cwd: "C:/work/site" } }]);
		session.respondToApproval(approvals[0]!.id, "allow");
		await flush();
		expect(child().answerTo(90)).toEqual({ id: 90, result: { decision: "accept" } });

		child().send({ id: 91, method: "item/commandExecution/requestApproval", params: { itemId: "c2", command: "del *", cwd: "C:/work/site" } });
		await flush();
		session.respondToApproval(approvals[1]!.id, "deny");
		await flush();
		expect(child().answerTo(91)).toEqual({ id: 91, result: { decision: "decline" } });
	});

	test("auto-edit accepts a file change inside the folder without a card", async () => {
		const { session, child, approvals } = setup({ permission: "auto-edit" });
		session.send("edit");
		await flush();
		child().send({ method: "item/started", params: { item: { type: "fileChange", id: "f1", changes: [{ path: "C:\\work\\site\\notes.txt", kind: { type: "add" }, diff: "hi\n" }] } } });
		child().send({ id: 92, method: "item/fileChange/requestApproval", params: { itemId: "f1" } });
		await flush();
		expect(approvals).toEqual([]);
		expect(child().answerTo(92)).toEqual({ id: 92, result: { decision: "accept" } });
	});

	test("auto-edit still asks when a change reaches outside the folder", async () => {
		const { session, child, approvals } = setup({ permission: "auto-edit" });
		session.send("edit");
		await flush();
		child().send({ method: "item/started", params: { item: { type: "fileChange", id: "f2", changes: [{ path: "C:/work/other/x.txt", kind: { type: "add" }, diff: "x\n" }] } } });
		child().send({ id: 93, method: "item/fileChange/requestApproval", params: { itemId: "f2" } });
		await flush();
		expect(approvals).toHaveLength(1);
		expect(approvals[0]!.toolName).toBe("Edit");
		expect(approvals[0]!.input).toMatchObject({ file_path: "C:/work/other/x.txt", diff: "x\n" });
		expect(child().answerTo(93)).toBeUndefined();
	});

	test("ask mode shows a card for a file change even inside the folder", async () => {
		const { session, child, approvals } = setup({ permission: "ask" });
		session.send("edit");
		await flush();
		child().send({ method: "item/started", params: { item: { type: "fileChange", id: "f3", changes: [{ path: "C:/work/site/a.txt", kind: { type: "add" }, diff: "a\n" }] } } });
		child().send({ id: 94, method: "item/fileChange/requestApproval", params: { itemId: "f3" } });
		await flush();
		expect(approvals).toHaveLength(1);
	});

	test("stop interrupts the turn, and an approval arriving after it is declined at once without a card", async () => {
		const { session, child, approvals } = setup();
		session.send("long job");
		await flush();
		await session.stop();
		await flush();
		expect(child().requests("turn/interrupt")[0]!.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
		child().send({ id: 95, method: "item/commandExecution/requestApproval", params: { itemId: "c9", command: "rm -rf x", cwd: "C:/work/site" } });
		await flush();
		expect(approvals).toEqual([]);
		expect(child().answerTo(95)).toEqual({ id: 95, result: { decision: "decline" } });
	});

	test("Stop pressed before the turn's id arrives still interrupts that turn once it does", async () => {
		const { session, spawn } = setup();
		spawn.mockImplementationOnce(() => {
			const c = new FakeCodex();
			c.holdTurnStart = true;
			return c as unknown as ChildLike;
		});
		session.send("long job");
		await flush();
		const c = spawn.mock.results[0]!.value as unknown as FakeCodex;
		expect(c.requests("turn/start")).toHaveLength(1);
		await session.stop();
		expect(c.requests("turn/interrupt")).toHaveLength(0);
		c.releaseTurnStart();
		await flush();
		expect(c.requests("turn/interrupt")[0]!.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
	});

	test("a card still waiting when Stop is pressed is answered decline", async () => {
		const { session, child, approvals } = setup();
		session.send("go");
		await flush();
		child().send({ id: 96, method: "item/commandExecution/requestApproval", params: { itemId: "c1", command: "x", cwd: "C:/work/site" } });
		await flush();
		expect(approvals).toHaveLength(1);
		await session.stop();
		await flush();
		expect(child().answerTo(96)).toEqual({ id: 96, result: { decision: "decline" } });
	});

	test("after dispose an approval is declined and the process is killed", async () => {
		const { session, child, approvals } = setup();
		session.send("go");
		await flush();
		const c = child();
		session.dispose();
		expect(c.kill).toHaveBeenCalled();
		c.send({ id: 97, method: "item/commandExecution/requestApproval", params: { itemId: "c1", command: "x", cwd: "C:/work/site" } });
		await flush();
		expect(approvals).toEqual([]);
	});

	test("Codex exiting mid-turn is one run-error; the next message starts a new process that resumes the thread", async () => {
		const { session, children, events } = setup();
		session.send("first");
		await flush();
		children[0]!.stderr.write("\u001b[31mERROR\u001b[0m fatal: something broke\n");
		await flush();
		children[0]!.emit("exit", 1);
		await flush();
		const errors = events.filter((e) => e.kind === "run-error");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ reason: "codex-exited" });
		expect((errors[0] as { message: string }).message).toContain("ERROR fatal: something broke");
		expect((errors[0] as { message: string }).message).not.toContain("\u001b");
		session.send("again");
		await flush();
		expect(children).toHaveLength(2);
		expect(children[1]!.requests("thread/resume")[0]!.params).toMatchObject({ threadId: "thread-1" });
		expect(children[1]!.requests("turn/start")).toHaveLength(1);
	});

	test("a new model, mode or effort applies from the next turn", async () => {
		const { session, child } = setup();
		session.send("one");
		await flush();
		turnDone(child());
		await flush();
		await session.setModel("gpt-6.1-sol");
		await session.setPermissionMode("full-access");
		await session.setEffort("high");
		session.send("two");
		await flush();
		expect(child().requests("turn/start")[1]!.params).toMatchObject({ model: "gpt-6.1-sol", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
	});

	test("a message sent while a turn runs waits for that turn to end", async () => {
		const { session, child } = setup();
		session.send("one");
		await flush();
		session.send("two");
		await flush();
		expect(child().requests("turn/start")).toHaveLength(1);
		turnDone(child());
		await flush();
		expect(child().requests("turn/start")).toHaveLength(2);
		expect(child().requests("turn/start")[1]!.params!["input"]).toEqual([{ type: "text", text: "two", text_elements: [] }]);
	});

	test("pasted images are left out with a note: v1 sends text only", async () => {
		const { session, child } = setup();
		session.send("look", [{ mediaType: "image/png", data: "AAAA" } as never]);
		await flush();
		const text = (child().requests("turn/start")[0]!.params!["input"] as { text: string }[])[0]!.text;
		expect(text).toMatch(/^look\n\n\[1 pasted image\(s\) left out/);
	});

	test("no slash commands", async () => {
		await expect(setup().session.commands()).resolves.toEqual([]);
	});
});
