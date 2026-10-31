import type { UpsStatus } from "./nut.ts";
import type { Task } from "./client.ts";

/**
 * What about the server is worth a notification. Each check is reduced to a
 * snapshot; comparing it with the previous one gives alerts for changes for
 * the worse (and the two recoveries that matter: power and reachability), so
 * a problem notifies once, not every five minutes.
 */

export type Snapshot = {
	/** Seconds since the epoch, as Proxmox counts. */
	readonly at: number;
	readonly reachable: boolean;
	readonly ups: UpsStatus | null;
	readonly guests: readonly { readonly vmid: number; readonly name: string; readonly status: string }[];
	readonly zfs: readonly { readonly name: string; readonly health: string }[];
	readonly disks: readonly { readonly name: string; readonly used: number; readonly total: number }[];
	/** Finished tasks; only those ending after the previous look count. */
	readonly tasks: readonly Task[];
};

export type Alert = { readonly key: string; readonly title: string; readonly body: string };

const FULL = 0.9;

const onBattery = (ups: UpsStatus | null): boolean => !!ups && /\bOB\b/.test(ups.status);
const lowBattery = (ups: UpsStatus | null): boolean => !!ups && /\bLB\b/.test(ups.status);
const percent = (used: number, total: number): number => (total > 0 ? Math.round((used / total) * 100) : 0);

export function diffAlerts(previous: Snapshot | null, current: Snapshot): Alert[] {
	if (!current.reachable) {
		return previous && previous.reachable
			? [{ key: "unreachable", title: "Proxmox is not answering", body: "The server did not answer the last check. It may be off, rebooting or off the network." }]
			: [];
	}
	const alerts: Alert[] = [];
	if (previous && !previous.reachable) {
		alerts.push({ key: "reachable", title: "Proxmox is answering again", body: "The server is back on the network." });
	}
	// While the server was silent its last snapshot is empty; judge against nothing rather than against that.
	const before = previous && previous.reachable ? previous : null;

	const ups = current.ups;
	if (lowBattery(ups) && !lowBattery(before?.ups ?? null)) {
		alerts.push({ key: "ups-low", title: "Server battery low", body: `UPS at ${ups?.charge ?? "?"} %. The server shuts down when it runs out.` });
	} else if (onBattery(ups) && !onBattery(before?.ups ?? null)) {
		alerts.push({ key: "ups-battery", title: "Server on battery", body: `Power cut: the UPS is running the server (${ups?.charge ?? "?"} %).` });
	} else if (!onBattery(ups) && onBattery(before?.ups ?? null) && ups) {
		alerts.push({ key: "ups-back", title: "Power is back", body: `The UPS is on mains again (${ups.charge ?? "?"} %).` });
	}

	if (before) {
		for (const guest of current.guests) {
			const was = before.guests.find((g) => g.vmid === guest.vmid);
			if (was?.status === "running" && guest.status !== "running") {
				alerts.push({ key: `guest-${guest.vmid}`, title: `${guest.name} ${guest.status}`, body: `Guest ${guest.vmid} was running at the last check and is now ${guest.status}.` });
			}
		}
	}

	for (const pool of current.zfs) {
		const was = before?.zfs.find((p) => p.name === pool.name);
		if (pool.health !== "ONLINE" && was?.health !== pool.health) {
			alerts.push({ key: `zfs-${pool.name}`, title: `ZFS pool ${pool.name} is ${pool.health}`, body: "A disk in the pool may have failed. Open Server for details." });
		}
	}

	for (const disk of current.disks) {
		const was = before?.disks.find((d) => d.name === disk.name);
		const full = disk.total > 0 && disk.used / disk.total >= FULL;
		const wasFull = !!was && was.total > 0 && was.used / was.total >= FULL;
		if (full && !wasFull) {
			alerts.push({ key: `disk-${disk.name}`, title: `${disk.name} is ${percent(disk.used, disk.total)} % full`, body: "Free some space before writes start failing." });
		}
	}

	if (before) {
		for (const task of current.tasks) {
			if (task.type !== "vzdump" || !task.endtime || task.endtime <= before.at || !task.status || task.status === "OK") continue;
			const warning = task.status.startsWith("WARNINGS");
			alerts.push({
				key: `task-${task.upid}`,
				title: warning ? "Backup finished with warnings" : "Backup failed",
				body: `${task.id ? `Guest ${task.id}: ` : ""}${task.status}`,
			});
		}
	}
	return alerts;
}
