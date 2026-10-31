import type { Activity } from "./presence.ts";

/**
 * Keeps Discord showing whatever `current()` says, without ever bothering the
 * user: Discord closed means a quiet retry every 15 s, Discord quitting
 * mid-session means the same, and bursts of changes (a turn starting, an
 * approval, the turn ending, all within a second) are coalesced because
 * Discord drops activity updates sent faster than 5 per 20 s.
 */

export interface IpcLike {
	connect(): Promise<void>;
	setActivity(activity: Activity | null): void;
	close(): void;
	onClose(listener: () => void): void;
}

export const RETRY_MS = 15_000;
export const MIN_GAP_MS = 4_000;

export class PresenceService {
	#ipc: IpcLike | null = null;
	#connecting = false;
	#stopped = false;
	#retry: ReturnType<typeof setTimeout> | null = null;
	#gap: ReturnType<typeof setTimeout> | null = null;
	/** What this connection last showed; undefined until something was sent on it. */
	#lastSent: string | undefined;
	#lastSentAt = 0;

	constructor(
		readonly create: () => IpcLike,
		/** The activity to show right now, or null for none (the setting is off). */
		readonly current: () => Activity | null,
	) {}

	/** Call whenever anything that feeds `current()` may have changed. */
	refresh(): void {
		if (this.#stopped) return;
		if (this.current() === null) {
			this.#clearRetry();
			this.#disconnect();
			return;
		}
		if (this.#ipc) this.#flush();
		else this.#connect();
	}

	stop(): void {
		this.#stopped = true;
		this.#clearRetry();
		this.#disconnect();
	}

	#flush(): void {
		const ipc = this.#ipc;
		if (!ipc || this.#gap) return;
		const activity = this.current();
		if (activity === null) return;
		const json = JSON.stringify(activity);
		if (json === this.#lastSent) return;
		const wait = this.#lastSentAt + MIN_GAP_MS - Date.now();
		if (this.#lastSent !== undefined && wait > 0) {
			this.#gap = setTimeout(() => {
				this.#gap = null;
				this.#flush();
			}, wait);
			return;
		}
		ipc.setActivity(activity);
		this.#lastSent = json;
		this.#lastSentAt = Date.now();
	}

	#connect(): void {
		if (this.#connecting || this.#retry) return;
		this.#connecting = true;
		const ipc = this.create();
		ipc.onClose(() => {
			if (this.#ipc !== ipc) return;
			this.#ipc = null;
			this.#scheduleRetry();
		});
		ipc.connect().then(
			() => {
				this.#connecting = false;
				if (this.#stopped || this.current() === null) {
					ipc.close();
					return;
				}
				this.#ipc = ipc;
				this.#lastSent = undefined;
				this.#flush();
			},
			() => {
				this.#connecting = false;
				this.#scheduleRetry();
			},
		);
	}

	#scheduleRetry(): void {
		if (this.#stopped || this.#retry || this.current() === null) return;
		this.#retry = setTimeout(() => {
			this.#retry = null;
			this.refresh();
		}, RETRY_MS);
	}

	#clearRetry(): void {
		if (this.#retry) clearTimeout(this.#retry);
		this.#retry = null;
	}

	/** Clear the status and let go of the pipe; Discord also clears it when the pipe closes. */
	#disconnect(): void {
		if (this.#gap) clearTimeout(this.#gap);
		this.#gap = null;
		const ipc = this.#ipc;
		this.#ipc = null;
		this.#lastSent = undefined;
		if (!ipc) return;
		ipc.setActivity(null);
		ipc.close();
	}
}
