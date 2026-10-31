import { describe, test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeSession } from "./service.ts";
import type { QueryFn, QueryParams, SdkUserMessage } from "./service.ts";
import type { UiEvent } from "./events.ts";

/**
 * The SDK is injected, so these tests exercise the session's own behaviour —
 * options, the live input stream, approvals, stop, failure — without spending
 * quota. The messages the fake yields are the real recordings used by the
 * converter tests.
 */

function recorded(name: string): unknown[] {
	return readFileSync(join(import.meta.dirname, "__fixtures__", `${name}.ndjson`), "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as unknown);
}

type Harness = {
	readonly session: ClaudeSession;
	readonly events: UiEvent[];
	readonly approvals: { id: string; toolName: string }[];
	readonly calls: QueryParams[];
	readonly sentMessages: SdkUserMessage[];
	/** Every applyFlagSettings call the session made on the live query. */
	readonly flagSettings: Record<string, unknown>[];
	readonly interrupted: () => number;
	/** Resolves once the run has finished draining. */
	readonly settled: () => Promise<void>;
	/** The canUseTool the session handed to the SDK. */
	readonly askPermission: (tool: string, input: Record<string, unknown>) => Promise<unknown>;
};

function harness(
	messages: readonly unknown[] = recorded("tool-use-read"),
	options: { resume?: string; throws?: Error; effort?: string } = {},
): Harness {
	const events: UiEvent[] = [];
	const approvals: { id: string; toolName: string }[] = [];
	const calls: QueryParams[] = [];
	const sentMessages: SdkUserMessage[] = [];
	const flagSettings: Record<string, unknown>[] = [];
	let interrupts = 0;
	let done!: () => void;
	const finished = new Promise<void>((resolve) => (done = resolve));

	const query: QueryFn = (params) => {
		calls.push(params);

		// Drain the live input stream in the background, like the CLI does.
		void (async () => {
			if (typeof params.prompt === "string") return;
			for await (const message of params.prompt) sentMessages.push(message);
		})();

		async function* run(): AsyncGenerator<unknown, void> {
			if (options.throws) throw options.throws;
			for (const message of messages) yield message;
			done();
		}

		const generator = run() as AsyncGenerator<unknown, void> & {
			interrupt: () => Promise<undefined>;
			setPermissionMode: (mode: string) => Promise<void>;
			applyFlagSettings: (settings: Record<string, unknown>) => Promise<void>;
		};
		generator.interrupt = async () => {
			interrupts += 1;
			return undefined;
		};
		generator.setPermissionMode = async () => undefined;
		generator.applyFlagSettings = async (settings) => {
			flagSettings.push(settings);
		};
		return generator;
	};

	const session = new ClaudeSession({
		query,
		claudePath: "C:\\claude.exe",
		cwd: "C:\\Users\\user\\TeezMind",
		onEvent: (event) => events.push(event),
		onApproval: (request) => approvals.push({ id: request.id, toolName: request.toolName }),
		...(options.resume === undefined ? {} : { resume: options.resume }),
		...(options.effort === undefined ? {} : { effort: options.effort }),
	});

	return {
		session,
		events,
		approvals,
		calls,
		sentMessages,
		flagSettings,
		interrupted: () => interrupts,
		settled: async () => {
			if (!options.throws) await finished;
			await vi.waitFor(() => {
				const last = events.at(-1);
				expect(last?.kind === "turn-end" || last?.kind === "run-error").toBe(true);
			});
		},
		askPermission: (tool, input) => {
			const canUseTool = calls[0]?.options["canUseTool"] as
				| ((
						tool: string,
						input: Record<string, unknown>,
						extra: { signal: AbortSignal },
				  ) => Promise<unknown>)
				| undefined;
			if (!canUseTool) throw new Error("the session never passed canUseTool to the SDK");
			return canUseTool(tool, input, { signal: new AbortController().signal });
		},
	};
}

describe("ClaudeSession — starting a run", () => {
	test("the first message starts one query and forwards converted events", async () => {
		const h = harness();
		h.session.send("read note.txt");
		await h.settled();

		expect(h.calls).toHaveLength(1);
		expect(h.events.map((e) => e.kind)).toEqual([
			"rate-limit",
			"session-ready",
			"tool-start",
			"tool-end",
			"text",
			"turn-end",
		]);
	});

	test("it runs in the workspace, on the located binary, with the user's own settings", () => {
		const h = harness();
		h.session.send("hello");

		const options = h.calls[0]?.options ?? {};
		expect(options["cwd"]).toBe("C:\\Users\\user\\TeezMind");
		expect(options["pathToClaudeCodeExecutable"]).toBe("C:\\claude.exe");
		expect(options["settingSources"]).toEqual(["user", "project", "local"]);
		expect(options["includePartialMessages"]).toBe(true);
		expect(options["canUseTool"]).toBeTypeOf("function");
	});

	test("resuming passes the session id through", () => {
		const h = harness(recorded("tool-use-read"), { resume: "abc-123" });
		h.session.send("carry on");
		expect(h.calls[0]?.options["resume"]).toBe("abc-123");
	});

	test("a follow-up continues the same run instead of starting another", async () => {
		const h = harness();
		h.session.send("first");
		h.session.send("second");

		await vi.waitFor(() => expect(h.sentMessages).toHaveLength(2));
		expect(h.calls).toHaveLength(1);
		expect(h.sentMessages[0]).toMatchObject({
			type: "user",
			parent_tool_use_id: null,
			message: { role: "user", content: "first" },
		});
		expect(h.sentMessages[1]).toMatchObject({ message: { content: "second" } });
	});

	test("pasted images go first as base64 blocks, then the text", async () => {
		const h = harness();
		h.session.send("what is this?", [{ mediaType: "image/png", data: "iVBORw0KGgo=" }]);
		await vi.waitFor(() => expect(h.sentMessages).toHaveLength(1));
		expect(h.sentMessages[0]?.message.content).toEqual([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
			{ type: "text", text: "what is this?" },
		]);
	});

	test("an image on its own is sent without an empty text block", async () => {
		const h = harness();
		h.session.send("", [{ mediaType: "image/jpeg", data: "/9j/4AAQ" }]);
		await vi.waitFor(() => expect(h.sentMessages).toHaveLength(1));
		expect(h.sentMessages[0]?.message.content).toEqual([
			{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } },
		]);
	});
});

describe("ClaudeSession — approvals", () => {
	test("a tool request reaches the UI and waits for the click", async () => {
		const h = harness();
		h.session.send("edit something");

		const decision = h.askPermission("Edit", { file_path: "a.ts" });
		await vi.waitFor(() => expect(h.approvals).toHaveLength(1));

		const pending = h.approvals[0];
		expect(pending?.toolName).toBe("Edit");

		h.session.respondToApproval(pending?.id ?? "", "allow");
		await expect(decision).resolves.toMatchObject({ behavior: "allow" });
	});

	test("deny comes back as a denial carrying a message", async () => {
		const h = harness();
		h.session.send("delete everything");

		const decision = h.askPermission("Bash", { command: "rm -rf /" });
		await vi.waitFor(() => expect(h.approvals).toHaveLength(1));
		h.session.respondToApproval(h.approvals[0]?.id ?? "", "deny");

		await expect(decision).resolves.toMatchObject({ behavior: "deny" });
	});

	test("a pending approval is denied when the session goes away, never left hanging", async () => {
		const h = harness();
		h.session.send("edit something");

		const decision = h.askPermission("Edit", { file_path: "a.ts" });
		await vi.waitFor(() => expect(h.approvals).toHaveLength(1));
		h.session.dispose();

		await expect(decision).resolves.toMatchObject({ behavior: "deny" });
	});
});

describe("ClaudeSession — reporting why a run failed", () => {
	/**
	 * A real failure on User's machine produced a card reading only
	 * "error_during_execution". Claude Code had died before it even created a
	 * session, so there was nothing in its logs either — the one place the
	 * reason existed was the CLI's stderr, which nothing was reading.
	 */
	test("the session subscribes to the CLI's stderr", () => {
		const h = harness();
		h.session.send("hello");
		expect(h.calls[0]?.options["stderr"]).toBeTypeOf("function");
	});

	test("stderr from a failed run reaches the error card", async () => {
		const h = harness([], { throws: new Error("process exited with code 1") });
		h.session.send("hello");

		const stderr = h.calls[0]?.options["stderr"] as (line: string) => void;
		stderr("claude: ENOENT loading settings");

		await vi.waitFor(() => expect(h.events.at(-1)?.kind).toBe("run-error"));
		const last = h.events.at(-1);
		expect(last?.kind === "run-error" && last.message).toContain(
			"claude: ENOENT loading settings",
		);
	});

	test("stderr is not attached to a run that succeeded", async () => {
		const h = harness();
		h.session.send("hello");
		const stderr = h.calls[0]?.options["stderr"] as (line: string) => void;
		stderr("some noisy warning");

		await h.settled();
		expect(h.events.map((e) => e.kind)).not.toContain("run-error");
	});
});

describe("ClaudeSession — stopping and failing", () => {
	test("stop interrupts the run rather than killing the process", async () => {
		const h = harness();
		h.session.send("long job");
		await h.session.stop();
		expect(h.interrupted()).toBe(1);
	});

	test("an SDK failure surfaces as a run-error the chat can show", async () => {
		const h = harness([], { throws: new Error("authentication_failed") });
		h.session.send("hello");

		await vi.waitFor(() => {
			const last = h.events.at(-1);
			expect(last?.kind).toBe("run-error");
		});
		const last = h.events.at(-1);
		expect(last?.kind === "run-error" && last.message).toContain("authentication_failed");
	});
});

describe("ClaudeSession — slash commands", () => {
	const session = (query: QueryFn): ClaudeSession =>
		new ClaudeSession({ query, claudePath: "C:\claude.exe", cwd: "C:\ws", onEvent: () => undefined, onApproval: () => undefined });

	test("lists the running session's commands, without the aliases the window does not use", async () => {
		const query: QueryFn = () => {
			async function* run(): AsyncGenerator<unknown, void> {}
			return Object.assign(run(), {
				supportedCommands: async () => [
					{ name: "usage", description: "Show plan usage", argumentHint: "", aliases: ["cost", "stats"] },
					{ name: "review", description: "Review a PR", argumentHint: "<pr>" },
				],
			});
		};
		const s = session(query);
		s.send("hello");
		expect(await s.commands()).toEqual([
			{ name: "usage", description: "Show plan usage", argumentHint: "" },
			{ name: "review", description: "Review a PR", argumentHint: "<pr>" },
		]);
	});

	test("is empty when the session can no longer answer", async () => {
		const query: QueryFn = () => {
			async function* run(): AsyncGenerator<unknown, void> {}
			return Object.assign(run(), {
				supportedCommands: async () => {
					throw new Error("Query closed");
				},
			});
		};
		const s = session(query);
		s.send("hello");
		expect(await s.commands()).toEqual([]);
	});

	test("is empty before the session has started", async () => {
		const query: QueryFn = () => {
			throw new Error("not started yet");
		};
		expect(await session(query).commands()).toEqual([]);
	});
});

describe("ClaudeSession — plan usage", () => {
	const session = (query: QueryFn): ClaudeSession =>
		new ClaudeSession({ query, claudePath: "C:\claude.exe", cwd: "C:\ws", onEvent: () => undefined, onApproval: () => undefined });
	const withUsage = (usage: (opts?: { skipBehaviors?: boolean }) => Promise<unknown>): QueryFn => () => {
		async function* run(): AsyncGenerator<unknown, void> {}
		return Object.assign(run(), { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage });
	};
	const answer = {
		rate_limits_available: true,
		rate_limits: { five_hour: { utilization: 42, resets_at: "2026-10-14T20:00:00Z" }, seven_day: { utilization: 18, resets_at: null } },
	};

	test("asks the live query for the plan limits only, and normalises the answer", async () => {
		const calls: unknown[] = [];
		const s = session(
			withUsage(async (opts) => {
				calls.push(opts);
				return answer;
			}),
		);
		s.send("hello");
		expect(await s.usage()).toEqual({
			fiveHour: { pct: 42, resetsAt: Date.parse("2026-10-14T20:00:00Z") },
			weekly: { pct: 18, resetsAt: null },
			weeklyOpus: null,
			weeklySonnet: null,
			models: [],
		});
		expect(calls).toEqual([{ skipBehaviors: true }]);
	});

	test("null before the session has started: there is no query to ask", async () => {
		let asked = 0;
		const s = session(
			withUsage(async () => {
				asked += 1;
				return answer;
			}),
		);
		expect(await s.usage()).toBeNull();
		expect(asked).toBe(0);
	});

	test("null when the SDK has no such method", async () => {
		const s = session(() => {
			async function* run(): AsyncGenerator<unknown, void> {}
			return run();
		});
		s.send("hello");
		expect(await s.usage()).toBeNull();
	});

	test("null when the call throws or answers something unexpected", async () => {
		const throws = session(
			withUsage(async () => {
				throw new Error("Query closed");
			}),
		);
		throws.send("hello");
		expect(await throws.usage()).toBeNull();
		const odd = session(withUsage(async () => ({ limits: "who knows" })));
		odd.send("hello");
		expect(await odd.usage()).toBeNull();
	});

	test("null when the call never answers, so the window's refresh is not stuck", async () => {
		vi.useFakeTimers();
		try {
			const s = session(withUsage(() => new Promise(() => undefined)));
			s.send("hello");
			const pending = s.usage();
			await vi.advanceTimersByTimeAsync(15_000);
			expect(await pending).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ClaudeSession — effort", () => {
	test("a chat's effort goes to the SDK at start; none is sent when it is the model default", async () => {
		const set = harness(recorded("tool-use-read"), { effort: "max" });
		set.session.send("hi");
		await set.settled();
		expect(set.calls[0]?.options["effort"]).toBe("max");

		const unset = harness(recorded("tool-use-read"), { effort: "" });
		unset.session.send("hi");
		await unset.settled();
		expect(unset.calls[0]?.options).not.toHaveProperty("effort");
	});

	test("changed before the first message, it applies at start without touching a query", async () => {
		const h = harness();
		await h.session.setEffort("low");
		h.session.send("hi");
		await h.settled();
		expect(h.calls[0]?.options["effort"]).toBe("low");
		expect(h.flagSettings).toEqual([]);
	});

	test("changed mid-session, it goes to the live query; Default clears it", async () => {
		const h = harness();
		h.session.send("hi");
		await h.settled();
		await h.session.setEffort("xhigh");
		await h.session.setEffort("");
		expect(h.flagSettings).toEqual([{ effortLevel: "xhigh" }, { effortLevel: null }]);
	});
});
