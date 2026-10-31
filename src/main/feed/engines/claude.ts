import { EventConverter } from "../../claude/events.ts";
import type { QueryFn } from "../../claude/service.ts";
import type { ModelInfo } from "../../../shared/feed-engine.ts";
import { fail } from "./http.ts";
import type { Generated, GenerateInput } from "./gemini.ts";

/**
 * Claude through the Agent SDK for the feed: one turn with no tools at all,
 * no settings (so no hooks, skills or CLAUDE.md), no MCP servers, in the
 * job's empty temp folder. The model gets the source as text and answers the
 * same JSON as the other engines; it can touch nothing.
 */

export const CLAUDE_MODELS: readonly ModelInfo[] = [
	{ id: "sonnet", label: "Sonnet" },
	{ id: "opus", label: "Opus" },
	{ id: "haiku", label: "Haiku" },
];

export type ClaudeDeps = {
	readonly query: QueryFn;
	/** The real executable, from the locator. */
	readonly claudePath: string;
	/** The job's own empty folder. */
	readonly cwd: string;
	/** Longest a run may take; the default matches the other engines. */
	readonly timeoutMs?: number;
};

const GENERATE_TIMEOUT_MS = 180_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** A usage-limit notice where the JSON should be. */
const LIMIT_NOTICE = /(limit|resets?\b|quota)/i;

export async function generateClaude(deps: ClaudeDeps, model: string, input: GenerateInput, signal: AbortSignal): Promise<Generated> {
	if (input.pdf) return fail("invalid", "Claude cannot read PDFs here. Use Gemini for PDFs, or link the article page instead.");
	if (signal.aborted) return fail("other", "Cancelled.");
	const abort = new AbortController();
	const onAbort = (): void => abort.abort();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		abort.abort();
	}, deps.timeoutMs ?? GENERATE_TIMEOUT_MS);
	const stopped = (): Generated => (timedOut ? fail("network", "Claude did not answer in time.") : fail("other", "Cancelled."));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const handle = deps.query({
			prompt: input.user,
			options: {
				cwd: deps.cwd,
				pathToClaudeCodeExecutable: deps.claudePath,
				model,
				systemPrompt: input.system,
				// No tools, no settings, no MCP: the run can read and write nothing.
				tools: [],
				// Nothing is pre-approved and nothing can ask: any tool or MCP call is denied, not prompted.
				permissionMode: "dontAsk",
				disallowedTools: ["mcp__*"],
				settingSources: [],
				strictMcpConfig: true,
				mcpServers: {},
				maxTurns: 1,
				persistSession: false,
				abortController: abort,
			},
		});
		const converter = new EventConverter();
		for await (const message of handle) {
			for (const event of converter.push(message)) {
				if (event.kind === "turn-end") return answer(event.text);
				if (event.kind === "run-error") return fail("other", event.message || event.reason);
				if (event.kind === "turn-cancelled") return stopped();
			}
		}
		return signal.aborted || timedOut ? stopped() : fail("other", "Claude ended without an answer.");
	} catch (error) {
		return signal.aborted || timedOut ? stopped() : fail("other", messageOf(error));
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

function answer(text: string): Generated {
	if (!text.includes("{") && LIMIT_NOTICE.test(text)) return fail("quota", text.trim().replace(/\s+/g, " ").slice(0, 200));
	return text.trim() ? { ok: true, text } : fail("other", "Claude returned no text.");
}
