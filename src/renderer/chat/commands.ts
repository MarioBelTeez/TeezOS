import type { AgentKind, SlashCommandInfo } from "../../main/agents/registry.ts";
import { fuzzyScore } from "../../shared/fuzzy.ts";

/**
 * The `/` menu: the session's own commands (skills and vault commands
 * included) plus TeezAI's, which stand in for the CLI's interactive-only
 * ones. Pure, so the merge and the filter are tested without a window.
 */

export type CommandAction = "insert" | "clear" | "model" | "mode" | "effort" | "context" | "cost" | "resume" | "btw";

export type CommandItem = {
	readonly name: string;
	readonly description: string;
	readonly action: CommandAction;
	/** Only when there is one, e.g. "<question>". */
	readonly argumentHint?: string;
};

type TeezCommand = CommandItem & { readonly claudeOnly: boolean };

/** Sorted by name; the menu lists them in this order, ahead of the CLI's. */
const TEEZ_COMMANDS: readonly TeezCommand[] = [
	{ name: "btw", description: "Ask a side question without touching the chat", action: "btw", argumentHint: "<question>", claudeOnly: false },
	{ name: "clear", description: "New chat tab with the same agent, model, mode and effort", action: "clear", claudeOnly: false },
	{ name: "context", description: "How full the context is, and the cost so far", action: "context", claudeOnly: true },
	{ name: "cost", description: "Session cost and turns", action: "cost", claudeOnly: true },
	{ name: "effort", description: "Pick how hard the agent thinks", action: "effort", claudeOnly: false },
	{ name: "mode", description: "Pick what the agent may do on its own", action: "mode", claudeOnly: false },
	{ name: "model", description: "Pick the model", action: "model", claudeOnly: false },
	{ name: "resume", description: "Open Past sessions", action: "resume", claudeOnly: true },
];

function ownCommands(agent: AgentKind): CommandItem[] {
	return TEEZ_COMMANDS.filter((c) => agent === "claude" || !c.claudeOnly).map(({ claudeOnly: _, ...item }) => item);
}

export function mergeCommands(cli: readonly SlashCommandInfo[], agent: AgentKind): CommandItem[] {
	const own = ownCommands(agent);
	if (agent !== "claude") return own;
	const taken = new Set(own.map((c) => c.name));
	const rest = cli
		.filter((c) => !taken.has(c.name))
		.map((c): CommandItem => ({
			name: c.name,
			description: c.description,
			action: "insert",
			...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	return [...own, ...rest];
}

/** Best match first; ties keep the menu's order. An empty query is the whole list, unchanged. */
export function filterCommands(items: readonly CommandItem[], query: string): readonly CommandItem[] {
	if (!query.trim()) return items;
	return items
		.map((item, index) => ({ item, index, score: fuzzyScore(query, item.name) }))
		.filter((entry): entry is { item: CommandItem; index: number; score: number } => entry.score !== null)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.item);
}

/**
 * A TeezAI command typed out in full and sent with Enter ("/btw why?",
 * "/clear"): it runs here instead of reaching the agent. Anything else —
 * CLI commands, plain text — returns null and is sent as written.
 */
export function teezCommand(text: string, agent: AgentKind): { readonly action: Exclude<CommandAction, "insert">; readonly argument: string } | null {
	const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return null;
	const command = ownCommands(agent).find((c) => c.name === match[1]);
	if (!command || command.action === "insert") return null;
	return { action: command.action, argument: (match[2] ?? "").trim() };
}
