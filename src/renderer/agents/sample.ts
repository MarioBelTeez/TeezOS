import { EMPTY_TREE, applyChatEvent, applyRuns, type AgentTree, type ChatMeta } from "./tree.ts";

/**
 * Dev builds only: a populated tree for the window capture, so the Agents
 * view can be checked without a live chat. App.tsx calls it from its
 * `import.meta.env.DEV` block; production builds drop it with that block.
 */
export function sampleAgentTree(now: number): AgentTree {
	const meta: ChatMeta = { chatId: "sample", title: "Build TeezOS 0.3.8", agent: "claude", model: "opus" };
	const at = (secondsAgo: number): number => now - secondsAgo * 1000;
	const start = (toolUseId: string, name: string, input: Record<string, unknown>, parentToolUseId: string | null = null) =>
		({ kind: "tool-start", sessionId: "s", toolUseId, name, input, parentToolUseId }) as const;
	const end = (toolUseId: string, isError = false) => ({ kind: "tool-end", sessionId: "s", toolUseId, isError, content: "", parentToolUseId: null }) as const;

	let tree = applyChatEvent(EMPTY_TREE, meta, start("r0", "Read", { file_path: "docs/superpowers/specs/2026-10-10-teezai-0.3.0-design.md" }), at(240));
	tree = applyChatEvent(tree, meta, start("D", "Agent", { description: "Fix the flaky feed test" }), at(180));
	tree = applyChatEvent(tree, meta, end("D", true), at(110));
	tree = applyChatEvent(tree, meta, start("A", "Agent", { description: "Write the browser view", model: "sonnet" }), at(200));
	tree = applyChatEvent(tree, meta, start("a1", "Read", { file_path: "src/renderer/views/BrowserView.tsx" }, "A"), at(190));
	tree = applyChatEvent(tree, meta, { kind: "subagent-text", sessionId: "s", parentToolUseId: "A", text: "The tab strip needs its own store; splitting it out first." }, at(150));
	tree = applyChatEvent(tree, meta, start("B", "Agent", { description: "Review the URL rules" }, "A"), at(90));
	tree = applyChatEvent(tree, meta, start("b1", "Grep", { pattern: "isSafeUrl" }, "B"), at(80));
	tree = applyChatEvent(tree, meta, end("B"), at(40));
	tree = applyChatEvent(tree, meta, start("a2", "Edit", { file_path: "src/renderer/state/browser.ts" }, "A"), at(12));
	tree = applyChatEvent(tree, meta, start("G", "Bash", { command: 'agy -p "map every IPC channel and its validation" --model gemini-3.1-pro-high' }), at(70));
	tree = applyChatEvent(tree, meta, start("C", "Task", { subagent_type: "security-reviewer" }), at(30));
	tree = applyChatEvent(tree, meta, start("c1", "Read", { file_path: "src/main/browser/permissions.ts" }, "C"), at(5));

	const other: ChatMeta = { chatId: "sample-2", title: "Vault digest", agent: "agy", model: "gemini-3.8-flash-low" };
	tree = applyChatEvent(tree, other, start("o1", "view_file", { AbsolutePath: "C:/Users/user/TeezMind/Home.md" }), at(600));
	tree = applyChatEvent(tree, other, { kind: "turn-end", sessionId: "s", ok: true, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: null }, at(540));

	return applyRuns(tree, [{ id: "sample-run", jobName: "Morning vault digest", status: "running", startedAt: at(95), finishedAt: null }], now);
}
