import { describe, expect, test, vi } from "vitest";
import { runBtw } from "./btw.ts";

function fakeQuery(messages: unknown[]) {
	const calls: unknown[] = [];
	const query = (params: unknown) => {
		calls.push(params);
		return (async function* () { for (const m of messages) yield m; })() as never;
	};
	return { query, calls };
}

describe("runBtw", () => {
	test("forks the chat's session with no tools and one turn", async () => {
		const { query, calls } = fakeQuery([
			{ type: "system", subtype: "init", session_id: "fork-1" },
			{ type: "result", subtype: "success", session_id: "fork-1", result: "42" },
		]);
		const deleted: string[] = [];
		const done = new Promise<string>((resolve) => {
			runBtw({ query, claudePath: "claude", cwd: "C:/v", model: "opus", sessionId: "main-1", question: "meaning?", onDelta: () => {}, onDone: resolve, onError: () => {}, deleteSession: async (id) => { deleted.push(id); } });
		});
		expect(await done).toBe("42");
		const options = (calls[0] as { options: Record<string, unknown> }).options;
		expect(options).toMatchObject({ resume: "main-1", forkSession: true, maxTurns: 1, allowedTools: [], permissionMode: "plan", model: "opus" });
		await vi.waitFor(() => expect(deleted).toEqual(["fork-1"]));
	});
	test("without a session it runs fresh, and the throwaway session is deleted too", async () => {
		const { query, calls } = fakeQuery([{ type: "system", subtype: "init", session_id: "new-1" }, { type: "result", subtype: "success", session_id: "new-1", result: "hi" }]);
		const deleted: string[] = [];
		await new Promise<string>((resolve) => runBtw({ query, claudePath: "c", cwd: "C:/v", model: "", sessionId: null, question: "q", onDelta: () => {}, onDone: resolve, onError: () => {}, deleteSession: async (id) => { deleted.push(id); } }));
		expect((calls[0] as { options: Record<string, unknown> }).options["resume"]).toBeUndefined();
		await vi.waitFor(() => expect(deleted).toEqual(["new-1"]));
	});
	test("a failed run reports an error", async () => {
		const { query } = fakeQuery([{ type: "result", subtype: "error_during_execution", session_id: "x", result: "boom" }]);
		const message = await new Promise<string>((resolve) => runBtw({ query, claudePath: "c", cwd: "C:/v", model: "", sessionId: null, question: "q", onDelta: () => {}, onDone: () => {}, onError: resolve, deleteSession: async () => {} }));
		expect(message).toContain("boom");
	});
	test("streams deltas, sends the question as the prompt and turns off every built-in tool", async () => {
		const { query, calls } = fakeQuery([
			{ type: "system", subtype: "init", session_id: "f" },
			{ type: "stream_event", session_id: "f", event: { type: "content_block_delta", delta: { type: "text_delta", text: "4" } } },
			{ type: "stream_event", session_id: "f", event: { type: "content_block_delta", delta: { type: "text_delta", text: "2" } } },
			{ type: "result", subtype: "success", session_id: "f", result: "42" },
		]);
		const deltas: string[] = [];
		await new Promise<string>((resolve) => runBtw({ query, claudePath: "c", cwd: "C:/v", model: "", sessionId: "m", question: "why?", onDelta: (t) => deltas.push(t), onDone: resolve, onError: () => {}, deleteSession: async () => {} }));
		expect(deltas).toEqual(["4", "2"]);
		const params = calls[0] as { prompt: unknown; options: Record<string, unknown> };
		expect(params.prompt).toBe("why?");
		expect(params.options["tools"]).toEqual([]);
		expect(params.options["model"]).toBeUndefined();
	});
	test("a run that throws reports the error and still deletes the fork", async () => {
		const deleted: string[] = [];
		const query = () =>
			(async function* () {
				yield { type: "system", subtype: "init", session_id: "fork-9" };
				throw new Error("process died");
			})() as never;
		const message = await new Promise<string>((resolve) => runBtw({ query, claudePath: "c", cwd: "C:/v", model: "", sessionId: "m", question: "q", onDelta: () => {}, onDone: () => {}, onError: resolve, deleteSession: async (id) => { deleted.push(id); } }));
		expect(message).toContain("process died");
		await vi.waitFor(() => expect(deleted).toEqual(["fork-9"]));
	});
	test("cancel interrupts and aborts the run, and reports nothing afterwards", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const interrupt = vi.fn(async () => { release(); });
		let options: Record<string, unknown> = {};
		let started = false;
		const query = (params: { options: Record<string, unknown> }) => {
			options = params.options;
			const run = (async function* () {
				yield { type: "system", subtype: "init", session_id: "fork-c" };
				started = true;
				await gate;
				throw new Error("aborted");
			})();
			return Object.assign(run, { interrupt }) as never;
		};
		const deleted: string[] = [];
		const onError = vi.fn();
		const onDone = vi.fn();
		const btw = runBtw({ query: query as never, claudePath: "c", cwd: "C:/v", model: "", sessionId: "m", question: "q", onDelta: () => {}, onDone, onError, deleteSession: async (id) => { deleted.push(id); } });
		await vi.waitFor(() => expect(started).toBe(true));
		btw.cancel();
		expect(interrupt).toHaveBeenCalled();
		expect((options["abortController"] as AbortController).signal.aborted).toBe(true);
		await vi.waitFor(() => expect(deleted).toEqual(["fork-c"]));
		expect(onError).not.toHaveBeenCalled();
		expect(onDone).not.toHaveBeenCalled();
	});
	test("runs isolated: no settings files (so no hooks) and no MCP servers", async () => {
		const { query, calls } = fakeQuery([{ type: "result", subtype: "success", session_id: "f", result: "ok" }]);
		await new Promise<string>((resolve) => runBtw({ query, claudePath: "c", cwd: "C:/v", model: "", sessionId: "m", question: "q", onDelta: () => {}, onDone: resolve, onError: () => {}, deleteSession: async () => {} }));
		const options = (calls[0] as { options: Record<string, unknown> }).options;
		expect(options["settingSources"]).toEqual([]);
		expect(options["strictMcpConfig"]).toBe(true);
		expect(options["mcpServers"]).toEqual({});
	});
});
