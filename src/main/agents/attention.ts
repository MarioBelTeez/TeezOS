import type { UiEvent } from "../claude/events.ts";
import type { ApprovalRequest } from "../claude/service.ts";
import type { AgentKind } from "./registry.ts";

/**
 * What in a chat is worth a Windows notification while TeezAI is in the
 * background: an answer ready, an approval waiting, a run that died. Pure, so
 * the main process only decides *whether* the window is looking.
 */

export type Attention = { readonly title: string; readonly body: string };
export type AttentionContext = { readonly agent: AgentKind; readonly workspace: string };

const AGENT_NAME: Record<AgentKind, string> = { claude: "Claude", agy: "Antigravity", codex: "Codex" };
const MAX_BODY = 160;

/** Control (C0, C1), zero-width, line/paragraph separator and bidi characters: invisible, or they reorder text. */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export const visible = (text: string): string => text.replace(HIDDEN, "");

/** One clean line: no markdown lead-ins or hidden characters, at most 160 characters. */
function oneLine(text: string): string {
	const line =
		text
			.split(/\r?\n/)
			.map((l) => l.replace(/^[\s#>*\-+`]+/, "").trim())
			.find(Boolean) ?? "";
	const clean = visible(line);
	return clean.length > MAX_BODY ? `${clean.slice(0, MAX_BODY - 1)}…` : clean;
}

export function attentionForEvent(event: UiEvent, context: AttentionContext): Attention | null {
	const name = AGENT_NAME[context.agent];
	const where = visible(context.workspace);
	switch (event.kind) {
		case "turn-end":
			return { title: `${name} finished · ${where}`, body: oneLine(event.text) || "Done." };
		case "run-error":
			// Refused at the bridge, or a chat already gone: the window said so already.
			if (event.reason === "bad-image" || event.reason === "chat-closed") return null;
			return { title: `${name} stopped · ${where}`, body: oneLine(event.message) || oneLine(event.reason) };
		default:
			return null;
	}
}

export function attentionForApproval(request: ApprovalRequest, context: AttentionContext): Attention {
	const input = request.input;
	const subject = [input["command"], input["file_path"], input["path"], input["url"], input["pattern"]].find(
		(value): value is string => typeof value === "string" && value.trim() !== "",
	);
	const body = subject ? `${request.toolName}: ${subject}` : request.toolName;
	return { title: `${AGENT_NAME[context.agent]} is waiting for you · ${visible(context.workspace)}`, body: oneLine(body) };
}
