import { AgyEventConverter } from "../agy/events.ts";
import { EventConverter, type UiEvent } from "../claude/events.ts";
import type { Job, RunEvent } from "../../../runner/src/types.ts";

export type RunItem = { readonly kind: "user"; readonly text: string } | { readonly kind: "notice"; readonly text: string } | UiEvent;

/**
 * A run's raw events as chat items, the way a live chat would have shown them.
 * Claude's stream-json lines carry `type`, Antigravity's carry `event`, so each
 * line goes to its own converter whatever engine the job uses today.
 */
export function runItems(job: Pick<Job, "prompt"> | null, events: readonly RunEvent[]): RunItem[] {
	const claude = new EventConverter();
	const agy = new AgyEventConverter({ model: "" });
	const items: RunItem[] = job ? [{ kind: "user", text: job.prompt }] : [];
	for (const event of events) {
		const data = event.data as Record<string, unknown>;
		if (data && data["type"] === "runner") {
			items.push({ kind: "notice", text: String(data["text"] ?? "") });
			continue;
		}
		const converted = data && typeof data["event"] === "string" ? agy.push(data) : claude.push(data);
		for (const ui of converted) {
			if (ui.kind === "rate-limit" || ui.kind === "session-ready") continue;
			// Its advice is for a chat; the runner notes a refusal with the job's own.
			if (ui.kind === "run-error" && ui.reason === "agy-denied") continue;
			items.push(ui);
		}
	}
	return items;
}
