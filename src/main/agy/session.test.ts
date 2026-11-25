import { describe, expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AgySession, permissionFlags, type ChildLike } from "./session.ts";
import type { AgySubagentWatcherOptions } from "./subagents.ts";
import type { UiEvent } from "../claude/events.ts";

type FakeChild = ChildLike & {
	input: string;
	emitter: EventEmitter;
	killed: boolean;
	stderr: PassThrough;
	finish: (lines: string, code?: number) => void;
};

function fakeChild(): FakeChild {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const emitter = new EventEmitter();
	const child: FakeChild = {
		stdin,
		stdout,
		stderr,
		pid: 123,
		input: "",
		emitter,
		killed: false,
		on: (event: string, listener: (...args: never[]) => void) => emitter.on(event, listener as never),
		kill: () => undefined,
		finish: (lines: string, code = 0) => {
			stdout.end(lines);
			setTimeout(() => emitter.emit("close", code), 5);
		},
	} as unknown as FakeChild;
	stdin.on("data", (chunk) => {
		child.input += String(chunk);
	});
	return child;
}

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8");
const waitFor = async (check: () => boolean): Promise<void> => {
	for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

describe("AgySession", () => {
	test("the prompt goes in on stdin as stream-json and the run streams back as events", async () => {
		const children: FakeChild[] = [];
		const calls: string[][] = [];
		const events: UiEvent[] = [];
		const session = new AgySession({
			agyPath: "agy.exe",
			cwd: "C:\\ws",
			model: "gemini-3.8-flash-medium",
			permission: "accept-edits",
			effort: "low",
			onEvent: (e) => events.push(e),
			spawn: (_file, args) => {
				calls.push([...args]);
				const child = fakeChild();
				children.push(child);
				return child;
			},
		});

		session.send("read note.txt");
		await waitFor(() => children[0]?.input.length !== 0);
		expect(JSON.parse(children[0]?.input ?? "")).toEqual({ event: "user", message: { content: "read note.txt" } });
		expect(calls[0]).toEqual(expect.arrayContaining(["--add-dir", "C:\\ws", "--model", "gemini-3.8-flash-medium", "--mode", "accept-edits", "-p="]));
		expect(calls[0]).not.toContain("--conversation");

		children[0]?.finish(fixture("read-file.ndjson"));
		await waitFor(() => events.some((e) => e.kind === "turn-end"));
		expect(session.conversationId).toBe("ad3c6521-3677-4761-b77a-7e57011a5563");

		// The second message continues the same conversation.
		session.send("and again");
		await waitFor(() => calls.length === 2);
		expect(calls[1]).toEqual(expect.arrayContaining(["--conversation", "ad3c6521-3677-4761-b77a-7e57011a5563"]));
	});

	test("Stop kills the run and reports a cancel, not an error", async () => {
		const events: UiEvent[] = [];
		const child = fakeChild();
		let killed = false;
		const session = new AgySession({
			agyPath: "agy.exe",
			cwd: "C:\\ws",
			model: "",
			permission: "ask",
			effort: "medium",
			onEvent: (e) => events.push(e),
			spawn: () => child,
			killTree: (c) => {
				killed = true;
				(c as FakeChild).finish("", 1);
			},
		});
		session.send("long job");
		await session.stop();
		await waitFor(() => events.length > 0);
		expect(killed).toBe(true);
		expect(events.map((e) => e.kind)).toEqual(["turn-cancelled"]);
	});

	test("a run that dies without a result explains itself with stderr", async () => {
		const events: UiEvent[] = [];
		const child = fakeChild();
		const session = new AgySession({
			agyPath: "agy.exe",
			cwd: "C:\\ws",
			model: "",
			permission: "ask",
			effort: "medium",
			onEvent: (e) => events.push(e),
			spawn: () => child,
		});
		session.send("hi");
		child.stderr.write("login required\n");
		child.finish("", 2);
		await waitFor(() => events.length > 0);
		expect(events[0]).toMatchObject({ kind: "run-error", reason: "agy-exit" });
		expect(events[0]?.kind === "run-error" && events[0].message).toContain("login required");
	});

	test("messages sent during a run wait their turn", async () => {
		const children: FakeChild[] = [];
		const session = new AgySession({
			agyPath: "agy.exe",
			cwd: "C:\\ws",
			model: "",
			permission: "ask",
			effort: "medium",
			onEvent: () => undefined,
			spawn: () => {
				const c = fakeChild();
				children.push(c);
				return c;
			},
		});
		session.send("first");
		session.send("second");
		expect(children).toHaveLength(1);
		children[0]?.finish(fixture("read-file.ndjson"));
		await waitFor(() => children.length === 2);
		await waitFor(() => (children[1]?.input ?? "").length > 0);
		expect(children[1]?.input).toContain("second");
	});

	test("writes attached images to a temp dir, adds --add-dir, and cleans up after the turn", async () => {
		const children: FakeChild[] = [];
		const calls: string[][] = [];
		const session = new AgySession({
			agyPath: "agy.exe",
			cwd: "C:\\ws",
			model: "gemini-3.8-flash-medium",
			permission: "plan",
			effort: "low",
			onEvent: () => undefined,
			spawn: (_file, args) => {
				calls.push([...args]);
				const c = fakeChild();
				children.push(c);
				return c;
			},
		});
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		session.send("check this", [{ mediaType: "image/png", data: png }]);
		await waitFor(() => children[0]?.input.length !== 0);
		const args = calls[0] ?? [];
		const addDirIndices = args.map((v, i) => (v === "--add-dir" ? i : -1)).filter((i) => i >= 0);
		expect(addDirIndices).toHaveLength(2);
		const imgDir = args[addDirIndices[1]! + 1]!;
		expect(existsSync(join(imgDir, "image-1.png"))).toBe(true);
		const sent = JSON.parse(children[0]?.input ?? "") as { message: { content: string } };
		expect(sent.message.content).toContain("check this");
		expect(sent.message.content).toContain("image-1.png");

		children[0]?.finish(fixture("read-file.ndjson"));
		await waitFor(() => !existsSync(imgDir));
		expect(existsSync(imgDir)).toBe(false);
	});
});

describe("AgySession — slash commands", () => {
	test("headless agy has none to offer", async () => {
		const session = new AgySession({ agyPath: "agy.exe", cwd: "C:\\ws", model: "", permission: "ask", effort: "low", onEvent: () => undefined });
		expect(await session.commands()).toEqual([]);
	});
});

describe("AgySession — side questions", () => {
	test("a side question's run expands no slash commands or skills; a chat's run is unchanged", () => {
		const base = { agyPath: "agy.exe", cwd: "C:\\ws", model: "", permission: "plan", effort: "low", onEvent: () => undefined };
		expect(new AgySession({ ...base, sideQuestion: true }).args()).toContain("--disable-slash-commands");
		expect(new AgySession(base).args()).not.toContain("--disable-slash-commands");
	});
});

describe("AgySession effort", () => {
	const effortOf = (args: string[]): string | undefined => args[args.indexOf("--effort") + 1];

	test("the next run uses the effort set on the chat", async () => {
		const session = new AgySession({ agyPath: "agy.exe", cwd: "C:\\ws", model: "", permission: "plan", effort: "low", onEvent: () => undefined });
		expect(effortOf(session.args())).toBe("low");
		await session.setEffort("high");
		expect(effortOf(session.args())).toBe("high");
	});

	test("derives --effort from an explicit model effort suffix so flags never conflict", async () => {
		const session = new AgySession({
			agyPath: "agy.exe",
			cwd: "C:\\ws",
			model: "gemini-3.8-flash-medium",
			permission: "plan",
			effort: "low",
			onEvent: () => undefined,
		});
		expect(effortOf(session.args())).toBe("medium");

		await session.setModel("claude-opus-4-6-high");
		expect(effortOf(session.args())).toBe("high");

		await session.setModel("gemini-4-neon-xhigh");
		expect(effortOf(session.args())).toBe("xhigh");

		await session.setModel("gemini-3.8-flash");
		expect(effortOf(session.args())).toBe("low");
	});
});

describe("AgySession — subagent watcher", () => {
	test("holds invoke_subagent tool-end, starts a watcher, forwards its events, and stops it on stop/dispose", async () => {
		const child = fakeChild();
		const events: UiEvent[] = [];
		const started: { opts: AgySubagentWatcherOptions; stopped: boolean }[] = [];
		const subId = "a13636b6-c40a-48ce-ac93-768c17934781";

		const session = new AgySession({
			agyPath: "agy.exe",
			cwd: "C:\\ws",
			model: "gemini-4-neon-high",
			permission: "full-auto",
			effort: "high",
			onEvent: (e) => events.push(e),
			spawn: () => child,
			createSubagentWatcher: (opts) => {
				const handle = { opts, stopped: false };
				started.push(handle);
				return {
					stop: () => {
						handle.stopped = true;
						opts.onDone?.();
					},
				};
			},
		});

		session.send("delegate this");
		const stream = [
			JSON.stringify({ event: "init", conversation_id: "parent-conv", init: { cwd: "C:\\ws", permission_mode: "full-auto", tools: [] } }),
			JSON.stringify({
				event: "step_update",
				step_update: {
					conversation_id: "parent-conv",
					step_index: 2,
					step_type: "tool",
					state: "ACTIVE",
					tool_name: "invoke_subagent",
					tool_info: { parameters: { Role: "Codebase Researcher", TypeName: "research", Model: "inherit" } },
				},
			}),
			JSON.stringify({
				event: "step_update",
				step_update: {
					conversation_id: "parent-conv",
					step_index: 2,
					step_type: "tool",
					state: "DONE",
					tool_name: "invoke_subagent",
					tool_info: { output: JSON.stringify({ conversationId: subId }) },
				},
			}),
			JSON.stringify({ event: "result", result: { conversation_id: "parent-conv", status: "SUCCESS", response: "Delegated." } }),
		].join("\n");

		child.finish(`${stream}\n`);
		await waitFor(() => events.some((e) => e.kind === "turn-end"));

		// Early launch tool-end was suppressed in favor of the watcher.
		expect(events.filter((e) => e.kind === "tool-start")).toHaveLength(1);
		expect(events.filter((e) => e.kind === "tool-end")).toHaveLength(0);
		expect(started).toHaveLength(1);
		expect(started[0]?.opts.parentToolUseId).toBe("parent-conv#2");
		expect(started[0]?.opts.sessionId).toBe("parent-conv");
		expect(started[0]?.opts.logPath).toContain(subId);
		expect(started[0]?.stopped).toBe(false);

		// Watcher emits nested steps and final completion after the parent turn already ended.
		started[0]?.opts.onEvent({
			kind: "tool-start",
			sessionId: "parent-conv",
			toolUseId: "parent-conv#2:sub:1:0",
			name: "read_file",
			input: { Path: "src/index.ts" },
			parentToolUseId: "parent-conv#2",
		});
		expect(events.at(-1)).toMatchObject({ kind: "tool-start", name: "read_file", parentToolUseId: "parent-conv#2" });

		// Stopping the session cleans up still-active watchers even when no parent process is running.
		await session.stop();
		expect(started[0]?.stopped).toBe(true);
	});

	test("forwards invoke_subagent tool-end normally when the launch fails or has no UUID", async () => {
		const child = fakeChild();
		const events: UiEvent[] = [];
		let watcherStarts = 0;

		const session = new AgySession({
			agyPath: "agy.exe",
			cwd: "C:\\ws",
			model: "",
			permission: "full-auto",
			effort: "medium",
			onEvent: (e) => events.push(e),
			spawn: () => child,
			createSubagentWatcher: () => {
				watcherStarts += 1;
				return { stop: () => undefined };
			},
		});

		session.send("delegate fail");
		const stream = [
			JSON.stringify({ event: "init", conversation_id: "c", init: {} }),
			JSON.stringify({
				event: "step_update",
				step_update: { conversation_id: "c", step_index: 1, step_type: "tool", state: "ACTIVE", tool_name: "invoke_subagent", tool_info: { parameters: {} } },
			}),
			JSON.stringify({
				event: "step_update",
				step_update: {
					conversation_id: "c",
					step_index: 1,
					step_type: "tool",
					state: "ERROR",
					tool_name: "invoke_subagent",
					tool_info: { error: { message: "denied" } },
				},
			}),
			JSON.stringify({ event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "" } }),
		].join("\n");

		child.finish(`${stream}\n`);
		await waitFor(() => events.some((e) => e.kind === "turn-end"));

		expect(watcherStarts).toBe(0);
		expect(events.some((e) => e.kind === "tool-end" && e.toolUseId === "c#1" && e.isError)).toBe(true);
	});
});

describe("permissionFlags", () => {
	test("maps each mode to agy's flags", () => {
		expect(permissionFlags("ask")).toEqual([]);
		expect(permissionFlags("plan")).toEqual(["--mode", "plan"]);
		expect(permissionFlags("accept-edits")).toEqual(["--mode", "accept-edits"]);
		expect(permissionFlags("full-auto")).toEqual(["--dangerously-skip-permissions"]);
	});
});
