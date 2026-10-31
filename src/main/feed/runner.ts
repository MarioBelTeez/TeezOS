import { randomUUID } from "node:crypto";
import {
	isFeedKind,
	MAX_FEED_ITEMS,
	MAX_FEED_NOTE,
	MAX_FEED_SOURCE,
	newItem,
	nextQueued,
	reduceFeed,
	type FeedAction,
	type FeedItem,
	type FeedKind,
} from "../../shared/feed.ts";
import { ENGINE_LABEL } from "../../shared/feed-engine.ts";
import { parseExtraction, type Extraction } from "./extract.ts";
import type { Completion, SourceContent } from "./engines/service.ts";
import type { SourceResult } from "./source.ts";
import type { WriteResult } from "./writer.ts";

/**
 * Runs the feed queue: one job at a time.
 *
 * A job reads its source in TeezAI (video transcript, article text, PDF
 * bytes), sends the text to a model that has no tools, validates the JSON it
 * answers and writes the notes itself. Every dependency is injected — the
 * reader, the engines, the writer, where the vault is — so the whole
 * lifecycle is tested with fakes. When a job has written notes, it commits
 * exactly those paths (never `add -A`: the vault's working tree is shared) and
 * pushes; a failed commit or push is logged and the job still ends done.
 */

/** The result of committing a job's notes: `message` goes into the job's log. */
export type FeedCommit = { readonly ok: boolean; readonly message: string };

export type FeedRunnerDeps = {
	readonly vault: () => string | null;
	/** The Groq key, handed to /watch (watch.py) to transcribe videos without subtitles; scrubbed from every log line. */
	readonly groqKey: () => string | null;
	/** Reads the job's source; stops when the job's signal aborts. Never throws in practice, but a throw is caught. */
	readonly readSource: (item: FeedItem, workDir: string, groqKey: string | null, signal: AbortSignal) => Promise<SourceResult>;
	/** The job's temp folder: made fresh when it starts, removed when it ends. */
	readonly workDir: { readonly create: (id: string) => Promise<string>; readonly remove: (dir: string) => Promise<void> };
	/** The Source note already filed from this item's link (vault-relative path), or null. */
	readonly filed?: (vault: string, item: FeedItem) => Promise<string | null>;
	/** Titles of the existing concept notes. */
	readonly conceptTitles: (vault: string) => Promise<string[]>;
	/** Asks the engine; its failures come back as values. */
	readonly complete: (item: FeedItem, source: SourceContent, conceptTitles: readonly string[], workDir: string, signal: AbortSignal) => Promise<Completion>;
	/** Writes the notes of a validated extraction. */
	readonly write: (vault: string, item: FeedItem, extraction: Extraction, now: number) => Promise<WriteResult>;
	/** Commits and pushes exactly `paths`; never throws in practice, but a throw is caught. No auto-commit when absent. */
	readonly commit?: (vault: string, paths: readonly string[], message: string) => Promise<FeedCommit>;
	readonly save: (items: FeedItem[]) => void;
	readonly emit: (items: FeedItem[]) => void;
	readonly now: () => number;
	/** True while the Feed module is off: no job starts (queued ones wait). Never paused when absent. */
	readonly paused?: () => boolean;
};

/** Asks again once when the model's answer is not the JSON it was asked for. */
const MAX_ASKS = 2;

type Running = {
	readonly id: string;
	readonly abort: AbortController;
	/** The Groq key this run was given; scrubbed from every log line. */
	readonly secret: string | null;
	cancelled: boolean;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class FeedRunner {
	readonly #deps: FeedRunnerDeps;
	#items: FeedItem[] = [];
	#current: Running | null = null;
	#stopped = false;

	constructor(deps: FeedRunnerDeps) {
		this.#deps = deps;
	}

	items(): FeedItem[] {
		return this.#items;
	}

	/** The persisted queue (already normalized); queued jobs start. */
	load(items: FeedItem[]): void {
		this.#items = [...items];
		this.#deps.emit(this.#items);
		this.#pump();
	}

	add(source: string, kind: FeedKind, note: string): FeedItem | { error: string } {
		if (typeof source !== "string" || source.length > MAX_FEED_SOURCE) return { error: "That link or path is too long." };
		if (typeof note !== "string" || note.length > MAX_FEED_NOTE) return { error: `The note is longer than ${MAX_FEED_NOTE} characters.` };
		if (!isFeedKind(kind)) return { error: "Unknown kind." };
		const item = newItem(randomUUID(), source, kind, note, this.#deps.now());
		if (!item) return { error: "Paste a video or article link, or drop a video or PDF file (no quotes, backticks or $ in it)." };
		const waiting = this.#items.some(
			(i) => i.source === item.source && (i.status === "queued" || i.status === "reading" || i.status === "writing"),
		);
		if (waiting) return { error: "That is already in the queue." };
		this.#set(this.#prune([...this.#items, item]));
		this.#pump();
		return item;
	}

	retry(id: string): void {
		this.#dispatch({ type: "retry", id });
		this.#pump();
	}

	cancel(id: string): void {
		const current = this.#current;
		if (current?.id === id) {
			current.cancelled = true;
			current.abort.abort();
		}
		this.#dispatch({ type: "cancel", id, now: this.#deps.now() });
		// A running job's slot frees when its run settles; a queued one changes nothing.
	}

	remove(id: string): void {
		if (this.#current?.id === id) this.cancel(id);
		this.#dispatch({ type: "remove", id });
	}

	/** The module was turned off: the running job is cancelled; queued ones wait (the `paused` predicate holds them). */
	pause(): void {
		if (this.#current) this.cancel(this.#current.id);
	}

	/** The module is back on: queued jobs start. */
	resume(): void {
		this.#pump();
	}

	/** On quit: the running job is abandoned as is (it reads back as failed). */
	stop(): void {
		this.#stopped = true;
		this.#current?.abort.abort();
	}

	#set(items: FeedItem[]): void {
		this.#items = items;
		this.#deps.save(items);
		this.#deps.emit(items);
	}

	#dispatch(action: FeedAction): void {
		this.#set(reduceFeed(this.#items, action));
	}

	/** Too many jobs: the oldest finished ones go first; waiting and running ones stay. */
	#prune(items: FeedItem[]): FeedItem[] {
		let excess = items.length - MAX_FEED_ITEMS;
		if (excess <= 0) return items;
		return items.filter((item) => {
			const finished = item.status === "done" || item.status === "failed" || item.status === "cancelled";
			if (excess > 0 && finished) {
				excess -= 1;
				return false;
			}
			return true;
		});
	}

	#pump(): void {
		while (!this.#stopped && !this.#current) {
			if (this.#deps.paused?.()) return;
			const next = nextQueued(this.#items);
			if (!next) return;
			// Everything the run needs is read before it is marked running, and a
			// dependency that throws fails this job: the queue never wedges on it.
			let setup: { vault: string | null; secret: string | null };
			try {
				setup = { vault: this.#deps.vault(), secret: this.#deps.groqKey() };
			} catch (error) {
				this.#dispatch({ type: "fail", id: next.id, error: `Could not start: ${messageOf(error)}`, now: this.#deps.now() });
				continue;
			}
			const { vault, secret } = setup;
			if (!vault) {
				this.#dispatch({ type: "fail", id: next.id, error: "No vault is set: pin your TeezMind folder first.", now: this.#deps.now() });
				continue;
			}
			this.#dispatch({ type: "start", id: next.id, now: this.#deps.now() });
			const running: Running = { id: next.id, abort: new AbortController(), secret, cancelled: false };
			this.#current = running;
			void this.#run(next, vault, running)
				.catch((error: unknown) => this.#fail(running, messageOf(error)))
				.finally(() => {
					if (this.#current === running) this.#current = null;
					this.#pump();
				});
		}
	}

	#live(running: Running): boolean {
		return !running.cancelled && !this.#stopped;
	}

	/** Text bound for the window and feed.json, with the run's Groq key taken out. */
	#scrub(running: Running, text: string): string {
		return running.secret ? text.split(running.secret).join("gsk_[hidden]") : text;
	}

	#fail(running: Running, error: string): void {
		if (this.#live(running)) this.#dispatch({ type: "fail", id: running.id, error: this.#scrub(running, error), now: this.#deps.now() });
	}

	#log(running: Running, line: string): void {
		if (this.#live(running)) this.#dispatch({ type: "log", id: running.id, line: this.#scrub(running, line) });
	}

	/** The job inside its own temp folder, which is removed however the job ends. */
	async #run(item: FeedItem, vault: string, running: Running): Promise<void> {
		let workDir: string;
		try {
			workDir = await this.#deps.workDir.create(item.id);
		} catch (error) {
			this.#fail(running, `Could not make the job's folder: ${messageOf(error)}`);
			return;
		}
		try {
			await this.#runIn(item, vault, workDir, running);
		} finally {
			await this.#deps.workDir.remove(workDir).catch(() => undefined);
		}
	}

	async #read(item: FeedItem, workDir: string, running: Running): Promise<SourceContent | null> {
		this.#log(running, `Reading ${item.source} (${item.input})`);
		const result = await this.#deps.readSource(item, workDir, running.secret, running.abort.signal);
		if (!this.#live(running)) return null;
		if (!result.ok) {
			this.#fail(running, result.error);
			return null;
		}
		if (result.pdf) {
			this.#log(running, `read: PDF, ${result.pdf.byteLength} bytes`);
			return { kind: "pdf", bytes: result.pdf };
		}
		this.#log(running, `read: ${result.text.length} characters`);
		return { kind: "text", text: result.text };
	}

	/** Asks the engine until its answer is valid JSON (twice at most); fails the job otherwise. */
	async #extract(item: FeedItem, source: SourceContent, titles: readonly string[], workDir: string, running: Running): Promise<Extraction | null> {
		let problem = "";
		for (let ask = 1; ask <= MAX_ASKS; ask += 1) {
			const done = await this.#deps.complete(item, source, titles, workDir, running.abort.signal);
			if (!this.#live(running)) return null;
			if (!done.ok) {
				this.#fail(running, done.error);
				return null;
			}
			this.#log(running, `answered by ${ENGINE_LABEL[done.engine]} (${done.model})`);
			const parsed = parseExtraction(done.text);
			if (parsed.ok) return parsed.value;
			problem = parsed.error;
			this.#log(running, ask < MAX_ASKS ? `${problem} Asking again.` : problem);
		}
		this.#fail(running, `${problem} Retry the item, or pick another model in Settings, Feed.`);
		return null;
	}

	/** Commits and pushes the notes a job wrote; the outcome is only logged, never a failure of the job. */
	async #commit(vault: string, changed: readonly string[], title: string, running: Running): Promise<void> {
		if (!this.#deps.commit || changed.length === 0) return;
		const message = `vault: feed — ${title.replace(/\s+/g, " ").trim()}`;
		const result = await this.#deps.commit(vault, changed, message).catch((error: unknown) => ({ ok: false, message: `commit failed: ${messageOf(error)}` }));
		this.#log(running, result.message);
	}

	async #runIn(item: FeedItem, vault: string, workDir: string, running: Running): Promise<void> {
		if (!this.#live(running)) return;
		// Already in the vault from this link: nothing is read and no model is asked, so no quota is spent.
		const filed = await this.#deps.filed?.(vault, item).catch(() => null);
		if (!this.#live(running)) return;
		if (filed) {
			this.#log(running, `Already filed as ${filed}; nothing was read or written.`);
			this.#dispatch({ type: "title", id: running.id, title: filed.replace(/^.*\//, "").replace(/\.md$/i, "") });
			this.#dispatch({ type: "finish", id: running.id, changed: [], drafts: [], now: this.#deps.now() });
			return;
		}
		const source = await this.#read(item, workDir, running);
		if (!source) return;
		this.#dispatch({ type: "phase", id: running.id, status: "writing" });
		const titles = await this.#deps.conceptTitles(vault).catch(() => []);
		const extraction = await this.#extract(item, source, titles, workDir, running);
		if (!extraction) return;

		const written = await this.#deps.write(vault, item, extraction, this.#deps.now());
		// Recorded before the live check: a cancel during the write still lists what was written.
		if (written.ok && written.changed.length > 0) this.#dispatch({ type: "wrote", id: running.id, changed: written.changed, drafts: written.drafts });
		if (!this.#live(running)) return;
		if (!written.ok) {
			this.#fail(running, written.error);
			return;
		}
		for (const warning of written.warnings) this.#log(running, warning);
		this.#log(running, `wrote ${written.changed.length} note(s)`);
		await this.#commit(vault, written.changed, written.title, running);
		if (!this.#live(running)) return;
		this.#dispatch({ type: "title", id: running.id, title: this.#scrub(running, written.title) });
		this.#dispatch({ type: "finish", id: running.id, changed: written.changed, drafts: written.drafts, now: this.#deps.now() });
	}
}
