import type { AgentKind } from "../../main/agents/registry.ts";

/**
 * What each agent can be asked to do, as the pickers list it. Pure data, so
 * the composer, the settings page and the hand-over can share it without
 * importing each other's components.
 */

export const CLAUDE_PERMISSIONS: readonly { readonly id: string; readonly label: string; readonly hint: string }[] = [
	{ id: "default", label: "Ask", hint: "Asks before edits and commands" },
	{ id: "acceptEdits", label: "Accept edits", hint: "Edits files without asking; still asks for commands" },
	{ id: "auto", label: "Auto", hint: "Claude approves safe actions itself and asks only for risky ones" },
	{ id: "plan", label: "Plan", hint: "Reads and plans, changes nothing" },
	{ id: "bypassPermissions", label: "Bypass", hint: "Never asks. Use only in a folder you can afford to lose." },
];

export const AGY_PERMISSIONS: readonly { readonly id: string; readonly label: string; readonly hint: string }[] = [
	{ id: "ask", label: "Default", hint: "Follows your Antigravity settings; anything that needs approval is refused (a headless run cannot ask)" },
	{ id: "plan", label: "Plan", hint: "Reads and plans, changes nothing" },
	{ id: "accept-edits", label: "Accept edits", hint: "Edits files without asking; commands still refused" },
	{ id: "full-auto", label: "Full auto", hint: "Skips every permission check, commands included. Use only in a folder you can afford to lose." },
];

export function agentName(agent: AgentKind): string {
	return agent === "claude" ? "Claude" : "Antigravity";
}
