import type { ReactNode } from "react";
import type { ServerOverview } from "../../../../src/main/proxmox/overview.ts";
import type { Snapshot } from "../../../../src/main/proxmox/watch.ts";
import { PullHint, Dot, Empty, ErrorLine, Panel, ScreenHeader, SectionTitle } from "../components/ui.tsx";
import { usePullToRefresh, useResource } from "../components/hooks.ts";
import { ago, bytes, duration, percent } from "../format.ts";

/**
 * The home server at a glance, read-only: guests, UPS, pools, disks and
 * backups. Pull down to refresh; there are deliberately no action buttons.
 */

type ServerData = { snapshot: Snapshot; overview: ServerOverview };

const REFRESH_MS = 30_000;
const WARN_PERCENT = 85;

function Meter({ used, total }: { used: number; total: number }): ReactNode {
	const value = percent(used, total);
	return <progress className={`meter ${value >= WARN_PERCENT ? "warn" : ""}`} max={100} value={value} aria-label={`${value}% used`} />;
}

function Row({ children }: { children: ReactNode }): ReactNode {
	return <li className="flex items-center gap-2 border-b border-border py-2 text-[16px]">{children}</li>;
}

function Node({ overview, reachable }: { overview: ServerOverview; reachable: boolean }): ReactNode {
	const { status } = overview;
	return (
		<Panel className="mt-3">
			<div className="flex items-center gap-2">
				<Dot tone={reachable ? "ok" : "bad"} />
				<span className="font-display text-[22px] tracking-wider">{overview.node}</span>
				<span className="ml-auto font-mono text-[12px] text-muted">up {duration(status.uptime)}</span>
			</div>
			<div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[13px]">
				<span>CPU {Math.round(status.cpu * 100)}%</span>
				<span>
					RAM {bytes(status.memory.used)} / {bytes(status.memory.total)}
				</span>
			</div>
			<div className="mt-2">
				<Meter used={status.memory.used} total={status.memory.total} />
			</div>
		</Panel>
	);
}

function Ups({ ups }: { ups: ServerOverview["ups"] }): ReactNode {
	if (!ups) return <Empty>No UPS reported.</Empty>;
	const onBattery = /\bOB\b/.test(ups.status);
	return (
		<Panel>
			<div className="flex items-center gap-2">
				<Dot tone={onBattery ? "warn" : "ok"} />
				<span className="text-[17px]">{onBattery ? "On battery" : "On mains"}</span>
				<span className="ml-auto font-mono text-[12px] text-muted">{ups.model}</span>
			</div>
			<div className="mt-1 grid grid-cols-3 font-mono text-[13px]">
				<span>{ups.charge ?? "–"}% charge</span>
				<span>{ups.runtimeSeconds === null ? "–" : duration(ups.runtimeSeconds)} left</span>
				<span>{ups.load ?? "–"}% load</span>
			</div>
		</Panel>
	);
}

export function Server({ active }: { active: boolean }): ReactNode {
	const server = useResource<ServerData>("/api/server", active, REFRESH_MS);
	const pull = usePullToRefresh(server.reload);
	const data = server.data;
	return (
		<section className="flex h-full flex-col">
			<ScreenHeader title="Server" />
			<div className="scroll-y safe-x min-h-0 flex-1 pb-6" {...pull.handlers}>
				<PullHint state={pull.state} />
				{server.error ? <ErrorLine text={server.error.text} offline={server.error.offline} /> : null}
				{!data && !server.error ? <Empty>Loading…</Empty> : null}
				{data ? (
					<>
						<Node overview={data.overview} reachable={data.snapshot.reachable} />
						<SectionTitle>Guests</SectionTitle>
						<ul>
							{data.overview.guests.map((guest) => (
								<Row key={guest.vmid}>
									<Dot tone={guest.status === "running" ? "ok" : "idle"} />
									<span className="min-w-0 flex-1 truncate">{guest.name}</span>
									<span className="font-mono text-[12px] text-muted">
										{guest.type === "lxc" ? "CT" : "VM"} {guest.vmid} · {guest.status === "running" ? `${Math.round(guest.cpu * 100)}% · ${bytes(guest.mem)}` : guest.status}
									</span>
								</Row>
							))}
						</ul>
						<SectionTitle>UPS</SectionTitle>
						<Ups ups={data.overview.ups} />
						<SectionTitle>Pools</SectionTitle>
						{data.overview.zfs.length === 0 ? <Empty>No ZFS pools.</Empty> : null}
						<ul>
							{data.overview.zfs.map((pool) => (
								<li key={pool.name} className="border-b border-border py-2">
									<div className="flex items-center gap-2 text-[16px]">
										<Dot tone={pool.health === "ONLINE" ? "ok" : "bad"} />
										<span className="flex-1">{pool.name}</span>
										<span className="font-mono text-[12px] text-muted">
											{pool.health} · {bytes(pool.alloc)} / {bytes(pool.size)}
										</span>
									</div>
									<Meter used={pool.alloc} total={pool.size} />
								</li>
							))}
						</ul>
						<SectionTitle>Disks</SectionTitle>
						<ul>
							{data.overview.storage.map((store) => (
								<li key={store.storage} className="border-b border-border py-2">
									<div className="flex items-center gap-2 text-[16px]">
										<Dot tone={store.active ? "ok" : "idle"} />
										<span className="flex-1">{store.storage}</span>
										<span className="font-mono text-[12px] text-muted">
											{percent(store.used, store.total)}% · {bytes(store.used)} / {bytes(store.total)}
										</span>
									</div>
									<Meter used={store.used} total={store.total} />
								</li>
							))}
						</ul>
						<SectionTitle>Backups</SectionTitle>
						{data.overview.backupJobs.map((job) => (
							<p key={job.id} className="font-mono text-[13px] text-muted">
								{job.enabled ? "" : "(off) "}
								{job.schedule} → {job.storage}
								{job["next-run"] ? ` · next ${new Date(job["next-run"] * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
							</p>
						))}
						{data.overview.backups.length === 0 ? <Empty>No backups found.</Empty> : null}
						<ul>
							{data.overview.backups.slice(0, 15).map((backup) => (
								<Row key={backup.volid}>
									<span className="flex-1 truncate">{backup.vmid === undefined ? backup.volid : `Guest ${backup.vmid}`}</span>
									<span className="font-mono text-[12px] text-muted">
										{bytes(backup.size)} · {ago(backup.ctime * 1000)}
									</span>
								</Row>
							))}
						</ul>
						<p className="mt-4 text-center font-mono text-[11px] text-muted">Read {ago(data.overview.fetchedAt)} · pull down to refresh</p>
					</>
				) : null}
			</div>
		</section>
	);
}
