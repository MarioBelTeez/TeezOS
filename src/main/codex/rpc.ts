import type { ChildLike } from "../agy/session.ts";

/**
 * Newline-delimited JSON-RPC with `codex app-server` over its stdio (see
 * docs/superpowers/notes/2026-10-31-codex-protocol.md). Three kinds of
 * incoming line: a response (`id` + `result`/`error`), a server request
 * (`id` + `method`: approvals) and a notification (`method` only).
 */

export type RpcHandlers = {
	readonly onNotification: (method: string, params: unknown) => void;
	/** A server→client request (approvals). Resolve with the result to send back. */
	readonly onServerRequest: (method: string, params: unknown, id: string | number) => Promise<unknown>;
	readonly onExit: (code: number | null, stderrTail: string) => void;
};

/** A line longer than this is not a protocol message TeezOS expects; it is dropped. */
export const MAX_LINE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_TAIL = 4_000;

type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout };

function isId(value: unknown): value is string | number {
	return typeof value === "string" || typeof value === "number";
}

export class CodexRpc {
	readonly #child: ChildLike;
	readonly #handlers: RpcHandlers;
	readonly #log: (line: string) => void;
	readonly #pending = new Map<string | number, Pending>();
	#nextId = 1;
	#buffer = "";
	#stderr = "";
	#closed = false;

	constructor(child: ChildLike, handlers: RpcHandlers, log: (line: string) => void = () => undefined) {
		this.#child = child;
		this.#handlers = handlers;
		this.#log = log;
		child.stdout.on("data", (chunk: Buffer | string) => this.#onData(chunk.toString()));
		child.stderr.on("data", (chunk: Buffer | string) => {
			this.#stderr = (this.#stderr + chunk.toString()).slice(-STDERR_TAIL);
		});
		child.on("exit", (code) => this.#onExit(code));
		child.on("error", (error) => {
			this.#log(`codex: ${error.message}`);
			this.#onExit(null);
		});
	}

	request<T = unknown>(method: string, params: unknown, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("Codex has exited."));
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`Codex timed out answering ${method}.`));
			}, timeoutMs);
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			this.#write({ id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.#write({ method, params });
	}

	close(): void {
		this.#closed = true;
		this.#rejectAll("Codex was closed.");
		this.#child.stdin.end();
	}

	#write(message: unknown): void {
		if (this.#closed) return;
		this.#child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	#onData(text: string): void {
		this.#buffer += text;
		let newline: number;
		while ((newline = this.#buffer.indexOf("\n")) >= 0) {
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			this.#onLine(line);
		}
		// An unterminated line that is already too long can never become a valid message.
		if (this.#buffer.length > MAX_LINE_BYTES) {
			this.#log(`codex: dropped an oversized line (${this.#buffer.length} bytes and counting)`);
			this.#buffer = "";
			this.#discarding = true;
		}
	}

	/** True while the rest of an oversized line is still arriving: it is skipped up to its newline. */
	#discarding = false;

	#onLine(raw: string): void {
		if (this.#discarding) {
			this.#discarding = false;
			return;
		}
		const line = raw.trim();
		if (!line) return;
		if (line.length > MAX_LINE_BYTES) {
			this.#log(`codex: dropped an oversized line (${line.length} bytes)`);
			return;
		}
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.#log(`codex: dropped a line that is not JSON (${line.slice(0, 80)})`);
			return;
		}
		if (typeof message !== "object" || message === null) return;
		const m = message as Record<string, unknown>;
		const method = typeof m["method"] === "string" ? m["method"] : null;
		if (isId(m["id"]) && method) {
			void this.#answer(m["id"], method, m["params"]);
			return;
		}
		if (isId(m["id"])) {
			const pending = this.#pending.get(m["id"]);
			if (!pending) return;
			this.#pending.delete(m["id"]);
			clearTimeout(pending.timer);
			const error = m["error"] as { message?: unknown } | undefined;
			if (error) pending.reject(new Error(typeof error.message === "string" ? error.message : "Codex returned an error."));
			else pending.resolve(m["result"]);
			return;
		}
		if (method) this.#handlers.onNotification(method, m["params"]);
	}

	async #answer(id: string | number, method: string, params: unknown): Promise<void> {
		try {
			const result = await this.#handlers.onServerRequest(method, params, id);
			this.#write({ id, result });
		} catch (error) {
			this.#write({ id, error: { code: -32603, message: error instanceof Error ? error.message : "TeezOS could not answer." } });
		}
	}

	#onExit(code: number | null): void {
		if (this.#closed && this.#pending.size === 0) {
			this.#handlers.onExit(code, this.#stderr);
			return;
		}
		this.#closed = true;
		this.#rejectAll("Codex exited.");
		this.#handlers.onExit(code, this.#stderr);
	}

	#rejectAll(reason: string): void {
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
			this.#pending.delete(id);
		}
	}
}
