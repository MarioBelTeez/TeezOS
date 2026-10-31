import type { UiEvent } from "../../../../src/main/claude/events.ts";
import { CaptureStreamFilter, parseCaptureBlocks, type Capture } from "./capture-block.ts";

/** The task's result, or `fallback` once `ms` have passed (or it failed). */
export function within<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	return Promise.race([task.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

/**
 * One turn's events on their way to the chat: capture blocks are taken out of
 * the text (streamed or whole) before anything sees them, and kept, with the
 * reply as shown, for when the turn ends. After `close()` nothing passes.
 */
export class ReplyShaper {
	readonly #apply: (event: UiEvent) => void;
	readonly #filter = new CaptureStreamFilter();
	#raw = "";
	#closed = false;
	reply: { text: string; captures: Capture[] } | null = null;

	constructor(apply: (event: UiEvent) => void) {
		this.#apply = apply;
	}

	close(): void {
		this.#closed = true;
	}

	readonly onEvent = (event: UiEvent): void => {
		if (this.#closed) return;
		if (event.kind === "text-delta") {
			this.#raw += event.text;
			const shown = this.#filter.push(event.text);
			if (shown) this.#apply({ ...event, text: shown });
			return;
		}
		if (event.kind === "text") {
			this.#raw += event.text;
			const shown = parseCaptureBlocks(event.text).text;
			if (shown) this.#apply({ ...event, text: shown });
			return;
		}
		if (event.kind === "turn-end") {
			const tail = this.#filter.flush();
			if (tail) this.#apply({ kind: "text-delta", sessionId: event.sessionId, text: tail });
			this.reply = parseCaptureBlocks(this.#raw || event.text);
			this.#apply({ ...event, text: this.reply.text });
			return;
		}
		this.#apply(event);
	};
}
