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

export const CODEX_PERMISSIONS: readonly { readonly id: string; readonly label: string; readonly hint: string }[] = [
	{ id: "ask", label: "Ask", hint: "Asks before every command and every file change" },
	{ id: "auto-edit", label: "Auto-edit", hint: "Edits files inside this folder without asking; commands still ask" },
	{ id: "full-access", label: "Full access", hint: "Never asks: runs commands and edits anywhere. Use only in a folder you can afford to lose." },
];

/** Each agent's look: the dot and title colours and the empty chat's line. Literal classes, so Tailwind keeps them. */
export const AGENT_STYLE: Readonly<Record<AgentKind, { readonly title: string; readonly tagline: string; readonly dot: string; readonly glow: string; readonly heading: string }>> = {
	claude: { title: "CLAUDE", tagline: " with your skills, hooks and memory.", dot: "bg-red-hot", glow: "shadow-[0_0_8px_var(--color-glow)]", heading: "to-red-hot drop-shadow-[0_0_18px_rgb(232_0_45/0.35)]" },
	agy: { title: "ANTIGRAVITY", tagline: " on your Google quota.", dot: "bg-violet", glow: "shadow-[0_0_8px_rgb(124_108_255/0.55)]", heading: "to-violet drop-shadow-[0_0_18px_rgb(124_108_255/0.35)]" },
	codex: { title: "CODEX", tagline: " on your ChatGPT plan.", dot: "bg-[#10a37f]", glow: "shadow-[0_0_8px_rgb(16_163_127/0.55)]", heading: "to-[#10a37f] drop-shadow-[0_0_18px_rgb(16_163_127/0.35)]" },
};

/** An error that a login fixes: Claude Code logged out, or Codex not logged in or unable to start. */
const LOGIN = /authentication_failed|not logged in|please log in|login required|\/login|invalid api key|oauth/i;

export function needsLogin(reason: string, text: string): boolean {
	return reason === "authentication_failed" || reason === "codex-logged-out" || reason === "codex-start" || LOGIN.test(text);
}

export type CodexReason = "codex-not-found" | "codex-logged-out" | "codex-unsupported";

/** The model menu's line for an agent that lists no models, saying what to do about it. */
export function emptyModelsItem(agent: AgentKind, codexReason: CodexReason | null): { readonly label: string; readonly hint: string } {
	if (agent !== "codex") return { label: "  No Gemini models", hint: "none listed by Antigravity" };
	switch (codexReason) {
		case "codex-not-found":
			return { label: "  Codex not installed", hint: "npm i -g @openai/codex, then codex login" };
		case "codex-logged-out":
			return { label: "  Codex not logged in", hint: "run codex login in the terminal" };
		case "codex-unsupported":
			return { label: "  Codex version not supported", hint: "install the version TeezOS supports" };
		default:
			return { label: "  No Codex models", hint: "none listed by Codex" };
	}
}

export function agentName(agent: AgentKind): string {
	if (agent === "claude") return "Claude";
	return agent === "codex" ? "Codex" : "Antigravity";
}
