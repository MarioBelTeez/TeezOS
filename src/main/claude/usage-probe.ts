import type { QueryFn, QueryHandle, SdkUserMessage } from "./service.ts";
import { normaliseUsage, type ClaudeUsage } from "../../shared/usage.ts";

/**
 * Claude's plan limits with no chat open.
 *
 * The usage call lives on a query, and a chat's query only exists after its
 * first message. For the window before that (app start, a fresh chat) a probe
 * opens a streaming-input query whose prompt never yields a message, asks for
 * the limits, and closes it. Streaming-input mode starts the CLI and waits for
 * the first user message before it talks to the model, so nothing is sent and
 * no tokens are spent. The query loads no settings, hooks or MCP servers and
 * has no tools, so it cannot run anything of the user's.
 */

/** Probes are at least this far apart; in between, the last answer stands. */
export const PROBE_MIN_INTERVAL_MS = 120_000;
/** An answer slower than this is given up on. */
export const PROBE_TIMEOUT_MS = 15_000;

export type ProbeDecision = "run" | "join" | "cached";

/** Start one, share the one already out, or answer from the last. Never two at once. */
export function probeDecision(state: { readonly now: number; readonly lastAt: number | null; readonly inFlight: boolean }): ProbeDecision {
	if (state.inFlight) return "join";
	if (state.lastAt !== null && state.now - state.lastAt < PROBE_MIN_INTERVAL_MS) return "cached";
	return "run";
}

export type UsageProbeDeps = {
	readonly query: QueryFn;
	readonly claudePath: string;
	/** Any existing directory; no project settings are read from it. */
	readonly cwd: string;
	readonly now: () => number;
	readonly timeoutMs?: number;
};

/** A prompt stream that yields nothing and ends only when released. */
function silentPrompt(): { readonly stream: AsyncIterable<SdkUserMessage>; readonly release: () => void } {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stream: AsyncIterable<SdkUserMessage> = {
		async *[Symbol.asyncIterator]() {
			await gate;
		},
	};
	return { stream, release };
}

export class UsageProbe {
	readonly #deps: UsageProbeDeps;
	#lastAt: number | null = null;
	#last: ClaudeUsage | null = null;
	#inFlight: Promise<ClaudeUsage | null> | null = null;
	#stop: (() => void) | null = null;

	constructor(deps: UsageProbeDeps) {
		this.#deps = deps;
	}

	get(): Promise<ClaudeUsage | null> {
		const decision = probeDecision({ now: this.#deps.now(), lastAt: this.#lastAt, inFlight: this.#inFlight !== null });
		if (decision === "join" && this.#inFlight) return this.#inFlight;
		if (decision === "cached") return Promise.resolve(this.#last);
		this.#lastAt = this.#deps.now();
		const running = this.#run().then((usage) => {
			this.#last = usage;
			this.#inFlight = null;
			this.#stop = null;
			return usage;
		});
		this.#inFlight = running;
		return running;
	}

	/** Closes a probe still out (the app is quitting). */
	dispose(): void {
		this.#stop?.();
	}

	async #run(): Promise<ClaudeUsage | null> {
		const { stream, release } = silentPrompt();
		let handle: QueryHandle | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let giveUp: (value: null) => void = () => undefined;
		const gaveUp = new Promise<null>((resolve) => {
			giveUp = resolve;
		});
		const close = (): void => {
			release();
			try {
				handle?.close?.();
			} catch {
				// Already gone.
			}
		};
		this.#stop = () => {
			giveUp(null);
		};
		try {
			handle = this.#deps.query({
				prompt: stream,
				options: {
					cwd: this.#deps.cwd,
					pathToClaudeCodeExecutable: this.#deps.claudePath,
					settingSources: [],
					tools: [],
					strictMcpConfig: true,
					mcpServers: {},
					permissionMode: "plan",
				},
			});
			const ask = handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
			if (!ask) return null;
			timer = setTimeout(() => giveUp(null), this.#deps.timeoutMs ?? PROBE_TIMEOUT_MS);
			const raw = await Promise.race([ask.call(handle, { skipBehaviors: true }), gaveUp]);
			return normaliseUsage(raw);
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
			close();
		}
	}
}
