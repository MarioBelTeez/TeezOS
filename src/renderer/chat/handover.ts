import type { Card } from "./reduce.ts";
import { summarize } from "./summarize.ts";

/**
 * The note a chat hands to a chat with the other agent. Claude and
 * Antigravity are separate processes with separate memory, so switching
 * agents starts a new chat; this gives it the gist of the old one. Built
 * locally from the cards — instant, no model call — and only prefilled, so
 * it can be edited before it is sent.
 */

const RECENT_CARDS = 12;
const MAX_MESSAGE = 600;
const MAX_TOTAL = 6000;

function cut(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > MAX_MESSAGE ? `${trimmed.slice(0, MAX_MESSAGE)}…` : trimmed;
}

function entry(card: Card, fromAgentLabel: string): string | null {
	switch (card.kind) {
		case "user":
			return `You: ${cut(card.text)}`;
		case "assistant":
			return `${fromAgentLabel}: ${cut(card.text)}`;
		case "tool":
			// What was done, not what came back: results are long and the new
			// agent can look again.
			return `- ${card.name}: ${summarize(card.input)}`;
		default:
			return null;
	}
}

export function buildHandover(cards: readonly Card[], fromAgentLabel: string, title: string): string {
	if (!cards.some((c) => c.kind === "user" || c.kind === "assistant")) return "";
	const entries = cards
		.filter((c) => c.kind === "user" || c.kind === "assistant" || c.kind === "tool")
		.slice(-RECENT_CARDS)
		.map((c) => entry(c, fromAgentLabel))
		.filter((line): line is string => line !== null);
	const header = `Context from the ${fromAgentLabel} chat «${title}»:`;

	// Over the cap, the oldest entries go first: the latest exchange is what
	// the next message most likely builds on.
	let length = header.length + entries.reduce((sum, line) => sum + 1 + line.length, 0);
	let start = 0;
	while (length > MAX_TOTAL && start < entries.length) {
		length -= 1 + (entries[start]?.length ?? 0);
		start += 1;
	}
	return [header, ...entries.slice(start)].join("\n");
}
