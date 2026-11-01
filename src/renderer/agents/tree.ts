import type { UiEvent } from "../../main/claude/events.ts";
import { summarize } from "../chat/summarize.ts";

/**
 * The Agents view's tree, as a pure reducer over the chat events the window
 * already receives and the automation runs it polls. Every open chat that
 * has worked is a root; a Claude `Agent`/`Task` call is a subagent under it
 * (and a subagent's own calls are that subagent's steps); a shell call that
 * runs `agy` is an Antigravity node; a run on the server is a root of its own.
 *
 * Events arrive once per token while a chat streams, so anything that does
 * not change the tree returns the very same object: no allocation, no render.
 */

export type AgentNodeKind = "chat" | "subagent" | "antigravity" | "automation";
export type AgentStatus = "running" | "done" | "failed" | "cancelled";
/** `seq` counts up per node and survives the 200-step cap, so a list can key on it. */
export type AgentStep = { readonly at: number; readonly text: string; readonly seq: number };
export type AgentNode = {
	readonly id: string;
	readonly parentId: string | null;
	readonly kind: AgentNodeKind;
	readonly title: string;
	readonly model: string;
	readonly status: AgentStatus;
	readonly startedAt: number;
	readonly endedAt: number | null;
	readonly current: string;
	readonly steps: readonly AgentStep[];
};
export type AgentTree = { readonly nodes: Readonly<Record<string, AgentNode>>; readonly order: readonly string[] };
export type ChatMeta = { readonly chatId: string; readonly title: string; readonly agent: "claude" | "agy" | "codex"; readonly model: string };
export type AgentRun = {
	readonly id: string;
	readonly jobName: string;
	readonly status: string;
	readonly startedAt: number;
	readonly finishedAt: number | null;
	readonly model?: string;
};

export const EMPTY_TREE: AgentTree = { nodes: {}, order: [] };

/** A finished root stays in view (and in memory) this long. */
export const HIDE_AFTER_MS = 30 * 60_000;
/** A node's log keeps its latest steps. */
export const MAX_STEPS = 200;
/** A root keeps its newest finished descendants; older ones leave with their subtrees. */
export const MAX_FINISHED_PER_ROOT = 50;
const SAYS_CHARS = 120;
const AGY_TITLE_CHARS = 60;
/** Deeper than this is not a tree a session builds; it stops a walk on bad data. */
const MAX_DEPTH = 64;

export const chatRootId = (chatId: string): string => `chat:${chatId}`;
const toolId = (toolUseId: string): string => `tool:${toolUseId}`;
const runId = (id: string): string => `run:${id}`;

/**
 * `agy` (or `agy.exe`, by path or the PowerShell call operator) in command
 * position: at the start or after `;`, `&`, `|`, `(` or a newline. As an
 * argument (`echo agy`) or a part of a word (`agyle`) it is not a run.
 */
const AGY_COMMAND = /(?:^|[;&|(\n])\s*(?:&\s*)?["']?(?:[^\s"';&|()]*[\\/])?agy(?:\.exe)?["']?(?=$|[\s;&|)])/i;

export function isAgyCommand(command: string): boolean {
	return AGY_COMMAND.test(command);
}

/** The prompt given with `-p`/`--prompt` when it is written inline; null when it comes from a file or stdin. */
function agyPrompt(args: string): string | null {
	const flag = /(?:^|\s)(?:-p|--prompt)(?:\s+|=)/.exec(args);
	if (!flag) return null;
	const rest = args.slice(flag.index + flag[0].length);
	const quote = rest[0];
	if (quote === '"' || quote === "'") {
		const close = rest.indexOf(quote, 1);
		return rest.slice(1, close === -1 ? undefined : close);
	}
	if (!rest || "($-@".includes(rest[0] ?? "")) return null;
	return rest.split(/\s/, 1)[0] ?? null;
}

function agyTitle(command: string): { readonly title: string; readonly model: string } {
	const match = AGY_COMMAND.exec(command);
	const args = match ? command.slice(match.index + match[0].length) : command;
	const prompt = agyPrompt(args);
	const firstLine = prompt?.split(/\r?\n/, 1)[0]?.trim() ?? "";
	const model = /(?:^|\s)(?:--model|-m)(?:\s+|=)["']?([\w.:-]+)/.exec(args)?.[1] ?? "";
	return { title: firstLine ? firstLine.slice(0, AGY_TITLE_CHARS) : "Antigravity run", model };
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function newNode(id: string, parentId: string | null, kind: AgentNodeKind, title: string, model: string, now: number): AgentNode {
	return { id, parentId, kind, title, model, status: "running", startedAt: now, endedAt: null, current: "", steps: [] };
}

function withStep(node: AgentNode, text: string, now: number): AgentNode {
	const step: AgentStep = { at: now, text, seq: (node.steps.at(-1)?.seq ?? -1) + 1 };
	const kept = node.steps.length >= MAX_STEPS ? node.steps.slice(node.steps.length - MAX_STEPS + 1) : node.steps;
	return { ...node, steps: [...kept, step], current: text };
}

function put(tree: AgentTree, node: AgentNode): AgentTree {
	const isNew = !tree.nodes[node.id];
	return { nodes: { ...tree.nodes, [node.id]: node }, order: isNew ? [...tree.order, node.id] : tree.order };
}

/** True when `id` is `ancestor` or sits somewhere under it. */
function isWithin(tree: AgentTree, id: string, ancestor: string): boolean {
	let current: string | null = id;
	for (let depth = 0; current !== null && depth < MAX_DEPTH; depth += 1) {
		if (current === ancestor) return true;
		current = tree.nodes[current]?.parentId ?? null;
	}
	return false;
}

/** Ends `id` and everything still running under it with `status`; the same tree when nothing ran. */
function closeSubtree(tree: AgentTree, id: string, status: AgentStatus, now: number): AgentTree {
	let nodes: Record<string, AgentNode> | null = null;
	for (const nodeId of tree.order) {
		const node = tree.nodes[nodeId];
		if (!node || node.status !== "running" || !isWithin(tree, nodeId, id)) continue;
		nodes ??= { ...tree.nodes };
		nodes[nodeId] = { ...node, status, endedAt: now };
	}
	return nodes ? { nodes, order: tree.order } : tree;
}

/**
 * Keeps the tree small for a session that runs all day. Dropped, each with
 * everything under it, but never while something under it still runs:
 *  - roots and descendants that finished more than HIDE_AFTER_MS ago;
 *  - a root's finished descendants beyond its newest MAX_FINISHED_PER_ROOT.
 * The same tree when nothing goes.
 */
export function prune(tree: AgentTree, now: number): AgentTree {
	const children = childrenOf(tree);
	const running = new Map<string, boolean>();
	const runsWithin = (id: string, depth = 0): boolean => {
		const known = running.get(id);
		if (known !== undefined) return known;
		const result =
			tree.nodes[id]?.status === "running" || (depth < MAX_DEPTH && (children[id] ?? []).some((child) => runsWithin(child, depth + 1)));
		running.set(id, result);
		return result;
	};
	const isStale = (node: AgentNode): boolean => node.endedAt !== null && now - node.endedAt > HIDE_AFTER_MS;

	const drop = new Set<string>();
	for (const id of tree.order) {
		const root = tree.nodes[id];
		if (!root || root.parentId !== null) continue;
		if (isStale(root) && !runsWithin(id)) {
			drop.add(id);
			continue;
		}
		// The root's finished descendants, newest first.
		const finished: AgentNode[] = [];
		const queue = [...(children[id] ?? [])];
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			const node = tree.nodes[next];
			if (!node) continue;
			if (node.endedAt !== null) finished.push(node);
			queue.push(...(children[next] ?? []));
		}
		finished.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
		finished.forEach((node, index) => {
			if ((isStale(node) || index >= MAX_FINISHED_PER_ROOT) && !runsWithin(node.id)) drop.add(node.id);
		});
	}
	if (drop.size === 0) return tree;

	const dropped = (id: string): boolean => {
		let current: string | null = id;
		for (let depth = 0; current !== null && depth < MAX_DEPTH; depth += 1) {
			if (drop.has(current)) return true;
			current = tree.nodes[current]?.parentId ?? null;
		}
		return false;
	};
	const order = tree.order.filter((id) => !dropped(id));
	const nodes: Record<string, AgentNode> = {};
	for (const id of order) {
		const node = tree.nodes[id];
		if (node) nodes[id] = node;
	}
	return { nodes, order };
}

/** The chat's root, running and named after the chat. The same tree when it already is. */
function ensureRunning(tree: AgentTree, meta: ChatMeta, now: number): AgentTree {
	const id = chatRootId(meta.chatId);
	const root = tree.nodes[id];
	if (!root) return put(prune(tree, now), newNode(id, null, "chat", meta.title, meta.model, now));
	if (root.status === "running") {
		if (root.title === meta.title && root.model === meta.model) return tree;
		return put(tree, { ...root, title: meta.title, model: meta.model });
	}
	// A new turn of a chat that finished one.
	return put(tree, { ...root, title: meta.title, model: meta.model, status: "running", startedAt: now, endedAt: null, current: "" });
}

function toolStart(tree: AgentTree, meta: ChatMeta, event: Extract<UiEvent, { kind: "tool-start" }>, now: number): AgentTree {
	const id = toolId(event.toolUseId);
	if (tree.nodes[id]) return tree;
	let next = ensureRunning(tree, meta, now);
	const parentKey = event.parentToolUseId ? toolId(event.parentToolUseId) : null;
	const parentId = parentKey && next.nodes[parentKey] ? parentKey : chatRootId(meta.chatId);
	const parent = next.nodes[parentId];
	if (!parent) return next;

	const input = event.input;
	if (event.name === "Agent" || event.name === "Task") {
		const title = str(input["description"]) || str(input["subagent_type"]) || "Subagent";
		next = put(next, withStep(parent, `${event.name}: ${oneLine(title)}`, now));
		return put(next, newNode(id, parentId, "subagent", oneLine(title), str(input["model"]), now));
	}
	const command = str(input["command"]);
	if ((event.name === "Bash" || event.name === "PowerShell") && isAgyCommand(command)) {
		const { title, model } = agyTitle(command);
		next = put(next, withStep(parent, `Antigravity: ${title}`, now));
		return put(next, newNode(id, parentId, "antigravity", title, model, now));
	}
	const summary = oneLine(summarize(input));
	return put(next, withStep(parent, summary ? `${event.name}: ${summary}` : event.name, now));
}

export function applyChatEvent(tree: AgentTree, meta: ChatMeta, event: UiEvent, now: number): AgentTree {
	switch (event.kind) {
		case "text-delta":
			return ensureRunning(tree, meta, now);
		case "tool-start":
			return toolStart(tree, meta, event, now);
		case "tool-end": {
			const node = tree.nodes[toolId(event.toolUseId)];
			if (!node || (node.kind !== "subagent" && node.kind !== "antigravity")) return tree;
			return closeSubtree(tree, node.id, event.isError ? "failed" : "done", now);
		}
		case "subagent-text": {
			const node = tree.nodes[toolId(event.parentToolUseId)];
			const text = oneLine(event.text).slice(0, SAYS_CHARS);
			return node && text ? put(tree, withStep(node, `says: ${text}`, now)) : tree;
		}
		// A turn's end is a natural moment to let go of what finished long ago.
		case "turn-end":
			return endTurn(tree, meta.chatId, "done", now);
		case "run-error":
			return endTurn(tree, meta.chatId, "failed", now);
		case "turn-cancelled":
			return endTurn(tree, meta.chatId, "cancelled", now);
		default:
			return tree;
	}
}

function endTurn(tree: AgentTree, chatId: string, status: AgentStatus, now: number): AgentTree {
	const closed = closeSubtree(tree, chatRootId(chatId), status, now);
	return closed === tree ? tree : prune(closed, now);
}

/** A chat closed while it worked: nothing more will arrive for it. */
export function endChat(tree: AgentTree, chatId: string, now: number): AgentTree {
	return endTurn(tree, chatId, "cancelled", now);
}

function runStatus(status: string): AgentStatus {
	if (status === "running") return "running";
	if (status === "ok" || status === "done") return "done";
	if (status === "cancelled") return "cancelled";
	return "failed";
}

/** Upserts the server's runs as `run:<id>` roots; the same tree when the poll changed nothing. */
export function applyRuns(tree: AgentTree, runs: readonly AgentRun[], now: number): AgentTree {
	let next = tree;
	for (const run of runs) {
		const status = runStatus(run.status);
		const endedAt = status === "running" ? null : (run.finishedAt ?? now);
		const id = runId(run.id);
		const existing = next.nodes[id];
		if (!existing && endedAt !== null && now - endedAt > HIDE_AFTER_MS) continue;
		const model = run.model ?? "";
		if (
			existing &&
			existing.status === status &&
			existing.endedAt === endedAt &&
			existing.title === run.jobName &&
			existing.model === model &&
			existing.startedAt === run.startedAt
		) {
			continue;
		}
		const base = existing ?? newNode(id, null, "automation", run.jobName, model, run.startedAt);
		next = put(next, { ...base, title: run.jobName, model, status, startedAt: run.startedAt, endedAt });
	}
	return prune(next, now);
}

/** Roots to draw, newest first; finished ones leave after HIDE_AFTER_MS. */
export function visibleRoots(tree: AgentTree, now: number): AgentNode[] {
	const roots: AgentNode[] = [];
	for (const id of tree.order) {
		const node = tree.nodes[id];
		if (node && node.parentId === null && (node.endedAt === null || now - node.endedAt <= HIDE_AFTER_MS)) roots.push(node);
	}
	return roots.sort((a, b) => b.startedAt - a.startedAt);
}

/** Each node's children in the order they started. */
export function childrenOf(tree: AgentTree): Readonly<Record<string, readonly string[]>> {
	const children: Record<string, string[]> = {};
	for (const id of tree.order) {
		const parentId = tree.nodes[id]?.parentId;
		if (!parentId) continue;
		(children[parentId] ??= []).push(id);
	}
	return children;
}
