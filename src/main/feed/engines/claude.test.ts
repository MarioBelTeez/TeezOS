import { describe, expect, test } from "vitest";
import { CLAUDE_MODELS, generateClaude } from "./claude.ts";
import type { QueryFn, QueryParams } from "../../claude/service.ts";

const result = (extra: Record<string, unknown>) => ({ type: "result", session_id: "s", duration_ms: 1, num_turns: 1, total_cost_usd: 0, ...extra });

function fakeQuery(messages: unknown[], seen: QueryParams[] = []): QueryFn {
	return (params) => {
		seen.push(params);
		async function* run(): AsyncGenerator<unknown, void> {
			for (const message of messages) yield message;
		}
		return run();
	};
}

const deps = (query: QueryFn) => ({ query, claudePath: "C:\\claude.exe", cwd: "C:\\temp\\job" });
const input = { system: "SYS", user: "USER" };

describe("generateClaude", () => {
	test("runs one tool-less turn in the job folder with no settings and no MCP servers", async () => {
		const seen: QueryParams[] = [];
		const out = await generateClaude(deps(fakeQuery([result({ subtype: "success", result: '{"title":"T"}' })], seen)), "sonnet", input, new AbortController().signal);
		expect(out).toEqual({ ok: true, text: '{"title":"T"}' });
		const call = seen[0]!;
		expect(call.prompt).toBe("USER");
		const o = call.options;
		expect(o["tools"]).toEqual([]);
		expect(o["allowedTools"]).toBeUndefined();
		expect(o["settingSources"]).toEqual([]);
		expect(o["strictMcpConfig"]).toBe(true);
		expect(o["mcpServers"]).toEqual({});
		expect(o["maxTurns"]).toBe(1);
		expect(o["model"]).toBe("sonnet");
		expect(o["systemPrompt"]).toBe("SYS");
		expect(o["cwd"]).toBe("C:\\temp\\job");
		expect(o["pathToClaudeCodeExecutable"]).toBe("C:\\claude.exe");
		expect(o["hooks"]).toBeUndefined();
		expect(o["permissionMode"]).toBe("dontAsk");
		expect(o["disallowedTools"]).toEqual(["mcp__*"]);
		expect(o["persistSession"]).toBe(false);
		expect(o["abortController"]).toBeInstanceOf(AbortController);
	});

	test("a failed run is a failure carrying the message", async () => {
		const out = await generateClaude(deps(fakeQuery([result({ subtype: "error_during_execution", is_error: true, result: "boom" })])), "sonnet", input, new AbortController().signal);
		expect(out).toEqual({ ok: false, kind: "other", error: "boom" });
	});

	test("a usage-limit message in place of an answer is a quota failure", async () => {
		const out = await generateClaude(deps(fakeQuery([result({ subtype: "success", result: "5-hour limit reached - resets 3am" })])), "sonnet", input, new AbortController().signal);
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.kind).toBe("quota");
			expect(out.error).toContain("resets 3am");
		}
	});

	test("an SDK that throws is a failure", async () => {
		const query: QueryFn = () => {
			throw new Error("spawn failed");
		};
		const out = await generateClaude(deps(query), "sonnet", input, new AbortController().signal);
		expect(out).toEqual({ ok: false, kind: "other", error: "spawn failed" });
	});

	test("a run that ends with no result is a failure", async () => {
		const out = await generateClaude(deps(fakeQuery([])), "sonnet", input, new AbortController().signal);
		expect(out.ok).toBe(false);
	});

	test("cancelling aborts the run and says so", async () => {
		const controller = new AbortController();
		controller.abort();
		const out = await generateClaude(deps(fakeQuery([result({ subtype: "success", result: "{}" })])), "sonnet", input, controller.signal);
		expect(out).toEqual({ ok: false, kind: "other", error: "Cancelled." });
	});

	test("a run that never answers is given up on after the timeout", async () => {
		const query: QueryFn = (params) =>
			(async function* (): AsyncGenerator<unknown, void> {
				const signal = (params.options["abortController"] as AbortController).signal;
				await new Promise((resolve) => signal.addEventListener("abort", resolve));
				throw new Error("aborted");
			})();
		const out = await generateClaude({ ...deps(query), timeoutMs: 20 }, "sonnet", input, new AbortController().signal);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toMatch(/in time/);
	});

	test("cannot read a PDF", async () => {
		const out = await generateClaude(deps(fakeQuery([])), "sonnet", { ...input, pdf: new Uint8Array([1]) }, new AbortController().signal);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toMatch(/PDF/);
	});

	test("offers Sonnet first", () => {
		expect(CLAUDE_MODELS[0]?.id).toBe("sonnet");
	});
});
