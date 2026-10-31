import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WRITE_RULES_SCRIPT } from "../../../../runner/src/agy.ts";
import { ChatService, PREAMBLE, TURN_TIMEOUT_MS, type ChatEvent } from "./chat-service.ts";
import { ChatStore } from "./chat-store.ts";
import type { ChildLike, Spawn } from "./job-user.ts";

const VAULT = "/var/lib/teez-phone/vault";
const AGY = "/home/phoneagent/.local/bin/agy";
const USER = "phoneagent";
const CONV = "ad3c6521-3677-4761-b77a-7e57011a5563";

type Call = { file: string; args: string[]; cwd: string; input: string; env: NodeJS.ProcessEnv | undefined };

function fakeChild(onInput: (input: string) => void): ChildLike & { finish: (out: string, code?: number) => void } {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const emitter = new EventEmitter();
	let input = "";
	stdin.on("data", (chunk) => (input += String(chunk)));
	stdin.on("finish", () => onInput(input));
	return {
		stdin,
		stdout,
		stderr,
		pid: 7,
		on: (event: string, listener: (...args: never[]) => void) => emitter.on(event, listener as never),
		kill: () => {
			stdout.end();
			setTimeout(() => emitter.emit("close", null), 1);
		},
		finish: (out: string, code = 0) => {
			stdout.end(out);
			setTimeout(() => emitter.emit("close", code), 1);
		},
	} as never;
}

const agyOutput = (reply: string): string =>
	[
		{ event: "init", conversation_id: CONV, init: { cwd: VAULT, tools: [] } },
		{ event: "step_update", step_update: { conversation_id: CONV, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: reply.slice(0, 9) } },
		{ event: "step_update", step_update: { conversation_id: CONV, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: reply.slice(9) } },
		{ event: "result", result: { conversation_id: CONV, status: "SUCCESS", response: reply, duration_seconds: 1, num_turns: 1 } },
	]
		.map((line) => JSON.stringify(line))
		.join("\n") + "\n";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "phone-chat-svc-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function make(reply: string, saveCapture = vi.fn(async () => ({ path: "thinking/phone-x.md", synced: true })), freshen = vi.fn(async () => true)) {
	const calls: Call[] = [];
	const spawn: Spawn = (file, args, options) => {
		const call: Call = { file, args: [...args], cwd: options.cwd, input: "", env: options.env };
		calls.push(call);
		const child = fakeChild((input) => {
			call.input = input;
			// agy answers once its prompt is in; everything else just succeeds.
			child.finish(args.includes(AGY) ? agyOutput(reply) : "");
		});
		return child;
	};
	const store = new ChatStore(dir);
	const service = new ChatService({
		store,
		saveCapture,
		spawn,
		jobUser: USER,
		agentVaultDir: VAULT,
		agyPath: () => AGY,
		claudePath: "claude",
		claudeToken: () => null,
		freshen,
		now: () => 1000,
	});
	return { service, store, calls, saveCapture, freshen };
}

async function sendAndWait(service: ChatService, id: string, text: string): Promise<{ chatId: string; title: string; firstLine: string }> {
	const done = new Promise<{ chatId: string; title: string; firstLine: string }>((resolve) => {
		service.onReplyDone((chatId, title, firstLine) => resolve({ chatId, title, firstLine }));
	});
	service.send(id, text);
	return done;
}

describe("ChatService", () => {
	it("runs agy as the job user in the agent vault with read-only rules written first", async () => {
		const { service, calls, freshen } = make("Here is the answer from [[Home]].");
		const chat = service.create({ engine: "agy", effort: "low" });
		const events: ChatEvent[] = [];
		service.subscribe(chat.id, (event) => events.push(event));
		await sendAndWait(service, chat.id, "what is on my plate?");

		expect(calls).toHaveLength(2);
		const [rules, agy] = calls;
		expect(rules?.file).toBe("sudo");
		expect(rules?.args.slice(0, 4)).toEqual(["-n", "-H", "-u", USER]);
		expect(rules?.args).toContain(process.execPath);
		expect(rules?.args).toContain(WRITE_RULES_SCRIPT);
		expect(JSON.parse(rules!.args.at(-1)!)).toEqual({ allow: [], deny: ["write_file(*)", "read_url(*)", "command(*)", "mcp(*)", "execute_url(*)"] });

		// Freshness comes from the service's own clone (GitSync), never a pull as the job user.
		expect(freshen).toHaveBeenCalledTimes(1);
		expect(calls.some((c) => c.args.includes("git"))).toBe(false);

		expect(agy?.file).toBe("sudo");
		expect(agy?.args).toEqual(expect.arrayContaining(["-u", USER, "env", "-C", VAULT, AGY, "--effort", "low"]));
		const sent = JSON.parse(agy!.input) as { message: { content: string } };
		expect(sent.message.content).toBe(`${PREAMBLE}\n\nwhat is on my plate?`);

		expect(events.some((e) => e.kind === "turn-end")).toBe(true);
		const stored = service.get(chat.id)!;
		expect(stored.conversationId).toBe(CONV);
		expect(stored.title).toBe("what is on my plate?");
		expect(stored.cards.map((c) => c.kind)).toEqual(["user", "assistant", "turn"]);

		// The second message continues the conversation, without the preamble.
		await sendAndWait(service, chat.id, "and tomorrow?");
		const second = calls.at(-1)!;
		expect(second.args).toEqual(expect.arrayContaining(["--conversation", CONV]));
		expect((JSON.parse(second.input) as { message: { content: string } }).message.content).toBe("and tomorrow?");
	});

	it("saves a capture block from the reply and adds a notice card", async () => {
		const reply = 'Noted, milk.\n<teez-capture links="Groceries" path="../CLAUDE.md">Buy oat milk on Friday.</teez-capture>';
		const { service, saveCapture } = make(reply);
		const chat = service.create({ engine: "agy", effort: "medium" });
		const events: ChatEvent[] = [];
		service.subscribe(chat.id, (event) => events.push(event));
		const done = await sendAndWait(service, chat.id, "remember to buy oat milk");

		expect(saveCapture).toHaveBeenCalledWith("Buy oat milk on Friday.", ["Groceries"], { provenance: "phone-chat" });
		expect(done).toEqual({ chatId: chat.id, title: "remember to buy oat milk", firstLine: "Noted, milk." });
		const stored = service.get(chat.id)!;
		const assistant = stored.cards.find((c) => c.kind === "assistant");
		expect(assistant && "text" in assistant ? assistant.text : "").toBe("Noted, milk.\n");
		expect(stored.cards.at(-1)).toMatchObject({ kind: "notice", text: "Saved to the vault: thinking/phone-x.md" });
		// Nothing of the block ever reaches a listener.
		expect(JSON.stringify(events)).not.toContain("teez-capture");
		expect(events.at(-1)).toMatchObject({ kind: "notice" });
	});

	it("reports a capture that could not be saved, and one not synced yet", async () => {
		const reply = "Ok.<teez-capture>one</teez-capture><teez-capture>two</teez-capture>";
		const saveCapture = vi
			.fn()
			.mockResolvedValueOnce({ path: "thinking/a.md", synced: false })
			.mockRejectedValueOnce(new Error("disk full"));
		const { service } = make(reply, saveCapture);
		const chat = service.create({ engine: "agy", effort: "medium" });
		await sendAndWait(service, chat.id, "log both");
		const notices = service.get(chat.id)!.cards.filter((c) => c.kind === "notice").map((c) => ("text" in c ? c.text : ""));
		expect(notices).toEqual(["Saved to the vault: thinking/a.md (saved, not synced yet)", "Could not save a capture: disk full"]);
	});

	it("says so when Antigravity is not installed for the job user", async () => {
		const { service, calls } = make("x");
		const svc = new ChatService({ ...service.deps, agyPath: () => null });
		const chat = svc.create({ engine: "agy", effort: "medium" });
		const events: ChatEvent[] = [];
		svc.subscribe(chat.id, (event) => events.push(event));
		svc.send(chat.id, "hi");
		await vi.waitFor(() => expect(events.some((e) => e.kind === "run-error")).toBe(true));
		expect(calls).toEqual([]);
	});

	it("stop cancels the running turn", async () => {
		const calls: Call[] = [];
		const store = new ChatStore(dir);
		const service = new ChatService({
			store,
			saveCapture: vi.fn(),
			// agy never answers on its own; the others succeed.
			spawn: (file, args, options) => {
				calls.push({ file, args: [...args], cwd: options.cwd, input: "", env: options.env });
				const child = fakeChild(() => {
					if (!args.includes(AGY)) child.finish("");
				});
				return child;
			},
			jobUser: USER,
			agentVaultDir: VAULT,
			agyPath: () => AGY,
			claudePath: "claude",
			claudeToken: () => null,
		});
		const chat = service.create({ engine: "agy", effort: "medium" });
		const events: ChatEvent[] = [];
		service.subscribe(chat.id, (event) => events.push(event));
		service.send(chat.id, "long question");
		await vi.waitFor(() => expect(calls.some((c) => c.args.includes(AGY))).toBe(true));
		expect(service.get(chat.id)?.running).toBe(true);
		await service.stop(chat.id);
		await vi.waitFor(() => expect(events.some((e) => e.kind === "turn-cancelled")).toBe(true));
		await vi.waitFor(() => expect(service.get(chat.id)?.running).toBe(false));
	});

	it("runs claude read-only as the job user with the server token, when it has one", async () => {
		const calls: Call[] = [];
		const lines = [
			{ type: "system", subtype: "init", session_id: "sess-1", model: "claude-x", tools: [] },
			{ type: "assistant", session_id: "sess-1", message: { content: [{ type: "text", text: "Hi.<teez-capture>keep</teez-capture>" }] } },
			{ type: "result", subtype: "success", session_id: "sess-1", result: "Hi.<teez-capture>keep</teez-capture>", total_cost_usd: 0 },
		];
		const saveCapture = vi.fn(async () => ({ path: "thinking/k.md", synced: true }));
		const service = new ChatService({
			store: new ChatStore(dir),
			saveCapture,
			spawn: (file, args, options) => {
				calls.push({ file, args: [...args], cwd: options.cwd, input: "", env: options.env });
				const child = fakeChild(() => child.finish(args.includes("claude") ? lines.map((l) => JSON.stringify(l)).join("\n") + "\n" : ""));
				return child;
			},
			jobUser: USER,
			agentVaultDir: VAULT,
			agyPath: () => AGY,
			claudePath: "claude",
			claudeToken: () => "tok",
		});
		const chat = service.create({ engine: "claude", effort: "high" });
		await sendAndWait(service, chat.id, "hello");

		expect(calls).toHaveLength(1);
		const claude = calls[0]!;
		expect(claude.args).toEqual(expect.arrayContaining(["-u", USER, "--preserve-env=CLAUDE_CODE_OAUTH_TOKEN,CI", "-C", VAULT, "--allowedTools", "Read,Glob,Grep,LS", "--effort", "high"]));
		// No project settings (the vault's hooks) and no MCP servers.
		expect(claude.args).toEqual(expect.arrayContaining(["--setting-sources", "user", "--strict-mcp-config"]));
		expect(claude.args.at(-1)).toBe(`${PREAMBLE}\n\nhello`);
		expect(claude.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("tok");
		expect(saveCapture).toHaveBeenCalledWith("keep", [], { provenance: "phone-chat" });
		const stored = service.get(chat.id)!;
		expect(stored.conversationId).toBe("sess-1");
		expect(stored.cards.find((c) => c.kind === "assistant")).toMatchObject({ text: "Hi." });

		await sendAndWait(service, chat.id, "again");
		expect(calls.at(-1)!.args).toEqual(expect.arrayContaining(["--resume", "sess-1"]));
	});

	it("notes a vault that could not be refreshed and still answers", async () => {
		const { service } = make("ok", undefined, vi.fn(async () => false));
		const chat = service.create({ engine: "agy", effort: "medium" });
		await sendAndWait(service, chat.id, "hi");
		const kinds = service.get(chat.id)!.cards.map((c) => c.kind);
		expect(kinds).toEqual(["user", "notice", "assistant", "turn"]);
	});

	it("a throwing reply listener does not turn a good reply into a failure", async () => {
		const { service } = make("fine");
		const chat = service.create({ engine: "agy", effort: "medium" });
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		service.onReplyDone(() => {
			throw new Error("push failed");
		});
		await sendAndWait(service, chat.id, "hi");
		await vi.waitFor(() => expect(service.get(chat.id)?.running).toBe(false));
		expect(service.get(chat.id)!.cards.some((c) => c.kind === "error")).toBe(false);
		spy.mockRestore();
	});

	it("stops a turn that runs past the timeout and frees the lock for the next chat", async () => {
		expect(TURN_TIMEOUT_MS).toBe(15 * 60_000);
		const calls: Call[] = [];
		let hang = true;
		const service = new ChatService({
			store: new ChatStore(dir),
			saveCapture: vi.fn(),
			spawn: (file, args, options) => {
				calls.push({ file, args: [...args], cwd: options.cwd, input: "", env: options.env });
				const child = fakeChild(() => {
					if (!args.includes(AGY)) child.finish("");
					else if (!hang) child.finish(agyOutput("second answer"));
				});
				return child;
			},
			jobUser: USER,
			agentVaultDir: VAULT,
			agyPath: () => AGY,
			claudePath: "claude",
			claudeToken: () => null,
			turnTimeoutMs: 50,
		});
		const first = service.create({ engine: "agy", effort: "medium" });
		const events: ChatEvent[] = [];
		service.subscribe(first.id, (event) => events.push(event));
		service.send(first.id, "hangs");
		await vi.waitFor(() => expect(events.some((e) => e.kind === "run-error" && e.message === "The turn took too long and was stopped.")).toBe(true));
		await vi.waitFor(() => expect(service.get(first.id)?.running).toBe(false));

		hang = false;
		const second = service.create({ engine: "agy", effort: "medium" });
		const done = await sendAndWait(service, second.id, "next");
		expect(done.firstLine).toBe("second answer");
	});

	it("starts the next turn only once a timed-out one has really ended", async () => {
		const order: string[] = [];
		let agyRuns = 0;
		const service = new ChatService({
			store: new ChatStore(dir),
			saveCapture: vi.fn(),
			spawn: (_file, args) => {
				if (!args.includes(AGY)) {
					const rules = fakeChild(() => rules.finish(""));
					return rules;
				}
				agyRuns += 1;
				const run = agyRuns;
				order.push(`start ${run}`);
				const child = fakeChild(() => {
					if (run > 1) child.finish(agyOutput("second answer"));
				});
				// The first one is slow to die: it closes 200 ms after it is asked to stop.
				if (run === 1)
					(child as { kill: () => void }).kill = () => {
						setTimeout(() => {
							order.push("end 1");
							child.finish("", 143);
						}, 200);
					};
				return child;
			},
			jobUser: USER,
			agentVaultDir: VAULT,
			agyPath: () => AGY,
			claudePath: "claude",
			claudeToken: () => null,
			turnTimeoutMs: 50,
		});
		const first = service.create({ engine: "agy", effort: "medium" });
		service.send(first.id, "hangs");
		const second = service.create({ engine: "agy", effort: "medium" });
		const done = await sendAndWait(service, second.id, "next");
		expect(done.firstLine).toBe("second answer");
		expect(order).toEqual(["start 1", "end 1", "start 2"]);
	});
});
