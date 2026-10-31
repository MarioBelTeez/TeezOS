import { describe, expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgySession, permissionFlags, type ChildLike } from "./session.ts";
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
	test("the next run uses the effort set on the chat", async () => {
		const session = new AgySession({ agyPath: "agy.exe", cwd: "C:\ws", model: "", permission: "plan", effort: "low", onEvent: () => undefined });
		const effortOf = (args: string[]): string | undefined => args[args.indexOf("--effort") + 1];
		expect(effortOf(session.args())).toBe("low");
		await session.setEffort("high");
		expect(effortOf(session.args())).toBe("high");
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
