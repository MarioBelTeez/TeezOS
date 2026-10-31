import type { Backup, Guest, NodeStatus, RrdPoint, Storage, Task, ZfsPool } from "./client.ts";
import type { LookApi } from "./look.ts";
import { readUps, type UpsStatus } from "./nut.ts";

/** Everything the Server view shows, in one object. */
export type ServerOverview = {
	readonly node: string;
	readonly status: NodeStatus;
	readonly rrd: readonly RrdPoint[];
	readonly guests: readonly Guest[];
	readonly storage: readonly Storage[];
	readonly zfs: readonly ZfsPool[];
	readonly tasks: readonly Task[];
	readonly backups: readonly Backup[];
	readonly backupJobs: readonly { readonly id: string; readonly schedule: string; readonly storage: string; readonly enabled: number; readonly "next-run"?: number }[];
	readonly ups: UpsStatus | null;
	readonly fetchedAt: number;
};

const MAX_BACKUPS = 60;

/** Reads the whole overview. Only the node status is required; every other part falls back to empty. */
export async function buildOverview(api: LookApi, now: () => number = Date.now): Promise<ServerOverview> {
	const node = api.node;
	const settle = async <T>(promise: Promise<T>, fallback: T): Promise<T> => promise.catch(() => fallback);
	const status = await api.request<NodeStatus>("GET", `/nodes/${node}/status`);
	const [rrd, lxc, qemu, storage, zfs, tasks, jobs, ups] = await Promise.all([
		settle(api.request<RrdPoint[]>("GET", `/nodes/${node}/rrddata`, { timeframe: "hour", cf: "AVERAGE" }), []),
		settle(api.request<Omit<Guest, "type">[]>("GET", `/nodes/${node}/lxc`), []),
		settle(api.request<Omit<Guest, "type">[]>("GET", `/nodes/${node}/qemu`), []),
		settle(api.request<Storage[]>("GET", `/nodes/${node}/storage`), []),
		settle(api.request<ZfsPool[]>("GET", `/nodes/${node}/disks/zfs`), []),
		settle(api.request<Task[]>("GET", `/nodes/${node}/tasks`, { limit: 25 }), []),
		settle(api.request<ServerOverview["backupJobs"]>("GET", "/cluster/backup"), []),
		readUps(api.host),
	]);
	const backupStores = storage.filter((s) => s.content.split(",").includes("backup"));
	const backups = (
		await Promise.all(
			backupStores.map((s) => settle(api.request<Backup[]>("GET", `/nodes/${node}/storage/${encodeURIComponent(s.storage)}/content`, { content: "backup" }), [])),
		)
	)
		.flat()
		.sort((a, b) => b.ctime - a.ctime);
	// Addresses of running containers, for the table (a stopped one has none).
	const addresses = new Map(
		await Promise.all(
			lxc
				.filter((g) => g.status === "running")
				.map(async (g) => {
					const nics = await settle(api.request<{ name: string; inet?: string }[]>("GET", `/nodes/${node}/lxc/${Number(g.vmid)}/interfaces`), []);
					const ips = nics.filter((n) => n.name !== "lo" && n.inet).map((n) => (n.inet ?? "").split("/")[0] ?? "");
					return [Number(g.vmid), ips] as const;
				}),
		),
	);
	const guests: Guest[] = [
		...lxc.map((g) => ({ ...g, vmid: Number(g.vmid), type: "lxc" as const, ips: addresses.get(Number(g.vmid)) ?? [] })),
		...qemu.map((g) => ({ ...g, vmid: Number(g.vmid), type: "qemu" as const })),
	].sort((a, b) => a.vmid - b.vmid);
	return { node, status, rrd, guests, storage, zfs, tasks, backups: backups.slice(0, MAX_BACKUPS), backupJobs: jobs, ups, fetchedAt: now() };
}
