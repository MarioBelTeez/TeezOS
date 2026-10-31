import type { Guest, NodeStatus, ProxmoxClient, Storage, Task, ZfsPool } from "./client.ts";
import { readUps } from "./nut.ts";
import type { Snapshot } from "./watch.ts";

/** The part of the client a look needs; a test can stand in for it. */
export type LookApi = Pick<ProxmoxClient, "node" | "host" | "request">;

const FIRST_LOOK_WINDOW_S = 3600;
const MAX_TASKS = 50;

/**
 * One look at the server, reduced to a Snapshot (what the alert diff
 * compares). `since` is the previous look's time in seconds; backup tasks are
 * fetched from there (the last hour on a first look). Shared by the desktop
 * watcher and the phone service. A failed node status throws: the caller
 * decides how many misses mean "not answering".
 */
export async function look(api: LookApi, now: () => number = Date.now, since?: number): Promise<Snapshot> {
	const at = Math.floor(now() / 1000);
	const node = api.node;
	const settle = async <T>(promise: Promise<T>, fallback: T): Promise<T> => promise.catch(() => fallback);
	const status = await api.request<NodeStatus>("GET", `/nodes/${node}/status`);
	const [lxc, qemu, storage, zfs, tasks, ups] = await Promise.all([
		settle(api.request<Omit<Guest, "type">[]>("GET", `/nodes/${node}/lxc`), []),
		settle(api.request<Omit<Guest, "type">[]>("GET", `/nodes/${node}/qemu`), []),
		settle(api.request<Storage[]>("GET", `/nodes/${node}/storage`), []),
		settle(api.request<ZfsPool[]>("GET", `/nodes/${node}/disks/zfs`), []),
		settle(api.request<Task[]>("GET", `/nodes/${node}/tasks`, { since: since ?? at - FIRST_LOOK_WINDOW_S, typefilter: "vzdump", limit: MAX_TASKS }), []),
		readUps(api.host),
	]);
	return {
		at,
		reachable: true,
		ups,
		guests: [...lxc, ...qemu].map((g) => ({ vmid: Number(g.vmid), name: g.name, status: g.status })),
		zfs: zfs.map((p) => ({ name: p.name, health: p.health })),
		// "local" is a folder on the root disk, already counted as the root disk.
		disks: [
			{ name: "Root disk", used: status.rootfs.used, total: status.rootfs.total },
			...storage.filter((s) => s.active && s.total > 0 && s.storage !== "local").map((s) => ({ name: s.storage, used: s.used, total: s.total })),
		],
		tasks,
	};
}
