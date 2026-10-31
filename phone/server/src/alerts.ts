import { diffAlerts, type Alert, type Snapshot } from "../../../src/main/proxmox/watch.ts";
import type { PushService } from "./push.ts";

/** Misses in a row before the server counts as not answering, like the desktop. */
const MISSES_BEFORE_UNREACHABLE = 2;
/** Recoveries tell once and are never "active": there is nothing to clear. */
const RECOVERY_KEYS = new Set(["reachable", "ups-back"]);
const DISK_FULL = 0.9;
const ALERT_URL = "/server";

export type AlertWatcherDeps = {
	/** One look at the server; `since` is the previous look's time (seconds) for the backup-task window. */
	readonly look: (since?: number) => Promise<Snapshot>;
	readonly push: Pick<PushService, "notify">;
	readonly intervalMs: number;
	readonly now?: () => number;
};

/** True once the condition behind an alert key no longer holds in this snapshot. */
function hasCleared(key: string, snap: Snapshot): boolean {
	if (key === "unreachable") return snap.reachable;
	if (!snap.reachable) return false; // nothing is known while the server is silent
	if (key === "ups-low") return !/\bLB\b/.test(snap.ups?.status ?? "");
	if (key === "ups-battery") return !/\bOB\b/.test(snap.ups?.status ?? "");
	if (key.startsWith("guest-")) return snap.guests.find((g) => `guest-${g.vmid}` === key)?.status === "running";
	if (key.startsWith("zfs-")) return snap.zfs.find((p) => `zfs-${p.name}` === key)?.health === "ONLINE";
	if (key.startsWith("disk-")) {
		const disk = snap.disks.find((d) => `disk-${d.name}` === key);
		return !disk || disk.total <= 0 || disk.used / disk.total < DISK_FULL;
	}
	if (key.startsWith("task-")) return !snap.tasks.some((t) => `task-${t.upid}` === key);
	return true;
}

/**
 * Looks at the server on a timer and pushes each alert once: a key stays in
 * `active` until its condition clears, so a problem never repeats every five
 * minutes. "Not answering" needs two misses in a row.
 */
export class AlertWatcher {
	readonly #deps: AlertWatcherDeps;
	readonly #active = new Set<string>();
	#last: Snapshot | null = null;
	#misses = 0;
	#running = false;
	#timer: NodeJS.Timeout | null = null;

	constructor(deps: AlertWatcherDeps) {
		this.#deps = deps;
	}

	start(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => void this.check(), this.#deps.intervalMs);
		this.#timer.unref();
		void this.check();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
	}

	/** One look; never throws. A look still running makes this one a no-op. */
	async check(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			const snapshot = await this.#snapshot();
			if (!snapshot) return;
			for (const key of [...this.#active]) if (hasCleared(key, snapshot)) this.#active.delete(key);
			const alerts = diffAlerts(this.#last, snapshot).filter((a) => !this.#active.has(a.key));
			this.#last = snapshot;
			for (const alert of alerts) if (!RECOVERY_KEYS.has(alert.key)) this.#active.add(alert.key);
			await this.#tell(alerts);
		} catch (error) {
			console.error("phone: server check failed", error);
		} finally {
			this.#running = false;
		}
	}

	async #snapshot(): Promise<Snapshot | null> {
		try {
			const snapshot = await this.#deps.look(this.#last?.reachable ? this.#last.at : undefined);
			this.#misses = 0;
			return snapshot;
		} catch {
			this.#misses += 1;
			if (this.#misses < MISSES_BEFORE_UNREACHABLE) return null;
			const now = this.#deps.now ?? Date.now;
			return { at: Math.floor(now() / 1000), reachable: false, ups: null, guests: [], zfs: [], disks: [], tasks: [] };
		}
	}

	async #tell(alerts: readonly Alert[]): Promise<void> {
		for (const alert of alerts) {
			try {
				await this.#deps.push.notify({ title: alert.title, body: alert.body, url: ALERT_URL, tag: `server-${alert.key}` });
			} catch (error) {
				console.error("phone: alert push failed", error);
			}
		}
	}
}
