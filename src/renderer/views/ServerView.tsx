import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Archive,
	BatteryCharging,
	Box,
	HardDrive,
	Loader2,
	Monitor,
	Play,
	Power,
	RefreshCw,
	RotateCcw,
	Square,
	TerminalSquare,
	Unplug,
} from "lucide-react";
import type { ServerOverview } from "../../main/ipc/server.ts";
import type { Guest, RrdPoint } from "../../main/proxmox/client.ts";
import { activeWorkspaceIdOf, useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { useTerminals } from "../terminal/TerminalDock.tsx";
import { IconButton } from "../shell/IconButton.tsx";
import { revealPanel } from "../shell/dock-actions.ts";

/**
 * The Proxmox host at a glance, refreshed every few seconds while visible:
 * health with the last hour as sparklines, the UPS, storage and ZFS, each
 * guest with its controls, backups and the task log. Shells open in the
 * terminal dock over SSH.
 */

const REFRESH_MS = 5000;

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(bytes > 100 * 1024 ** 3 ? 0 : 1)} GB`;
const pct = (used: number, total: number): number => (total > 0 ? Math.round((used / total) * 100) : 0);

function duration(seconds: number): string {
	if (!seconds) return "—";
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function rate(bytesPerSecond: number): string {
	if (bytesPerSecond > 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
	if (bytesPerSecond > 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
	return `${Math.round(bytesPerSecond)} B/s`;
}

export function ServerView(): React.JSX.Element {
	const [configured, setConfigured] = useState<boolean | null>(null);
	const [overview, setOverview] = useState<ServerOverview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const inFlight = useRef(false);

	const refresh = useCallback(async () => {
		// One request at a time: a slow answer must not be overtaken (and then
		// overwritten) by older ones stacking up behind it.
		if (inFlight.current) return;
		inFlight.current = true;
		setLoading(true);
		const result = await window.teez.server.overview().finally(() => {
			inFlight.current = false;
		});
		setLoading(false);
		if (result.ok) {
			setOverview(result.value);
			setError(null);
		} else if (result.reason === "not-configured") {
			setConfigured(false);
		} else {
			setError(result.reason);
		}
	}, []);

	useEffect(() => {
		void window.teez.server.status().then((s) => {
			setConfigured(s.configured);
			if (s.configured) void refresh();
		});
	}, [refresh]);

	useEffect(() => {
		if (!configured) return;
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void refresh();
		}, REFRESH_MS);
		return () => clearInterval(timer);
	}, [configured, refresh]);

	if (configured === null) return <div className="flex-1" />;
	if (!configured) {
		return (
			<Setup
				onDone={() => {
					setConfigured(true);
					void refresh();
				}}
			/>
		);
	}

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto max-w-[1400px] px-8 py-6">
				<Header
					overview={overview}
					loading={loading}
					error={error}
					onRefresh={() => void refresh()}
					onDisconnected={() => {
						setOverview(null);
						setConfigured(false);
					}}
				/>
				{overview ? (
					<>
						<Health overview={overview} />
						<Guests overview={overview} onChanged={() => setTimeout(() => void refresh(), 1500)} />
						<div className="mt-8 grid gap-8 xl:grid-cols-2">
							<Storage overview={overview} />
							<Backups overview={overview} />
						</div>
						<Tasks overview={overview} />
					</>
				) : error ? null : (
					<p className="mt-10 font-mono text-xs text-muted">Reading the server…</p>
				)}
			</div>
		</div>
	);
}

function Setup({ onDone }: { readonly onDone: () => void }): React.JSX.Element {
	const [alias, setAlias] = useState("pve");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const run = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		const result = await window.teez.server.setup(alias);
		setBusy(false);
		if (result.ok) {
			useUi.getState().toast(`Connected: ${result.value}`, "success");
			onDone();
		} else {
			setError(result.reason);
		}
	};

	return (
		<div className="flex flex-1 items-center justify-center p-10">
			<div className="max-w-xl">
				<p className="glow-text font-condensed text-xs uppercase tracking-[0.3em] text-red-hot">Proxmox</p>
				<h1 className="font-display text-5xl tracking-wide">CONNECT THE SERVER</h1>
				<p className="mt-3 text-[14px] leading-relaxed text-[#d8cdd2]">
					TeezOS uses your existing SSH key to create a dedicated <span className="font-mono text-text">teezai@pve</span> user
					with a limited role — status, guest power, backups and host reboot; no user, config or guest creation rights — and an API
					token for it. The token is encrypted with Windows' keystore, and every connection is pinned to the server's own
					certificate. Running this again replaces the token.
				</p>
				<div className="mt-6 flex items-center gap-2">
					<span className="font-mono text-[12px] text-muted">ssh</span>
					<input
						value={alias}
						onChange={(event) => setAlias(event.target.value)}
						className="w-40 bg-surface px-2 py-1.5 font-mono text-[13px] text-text outline-none ring-1 ring-border focus:glow"
					/>
					<button
						type="button"
						disabled={busy}
						onClick={() => void run()}
						className="cut-corner flex items-center gap-2 bg-red px-5 py-1.5 font-condensed text-sm uppercase tracking-wider disabled:opacity-60"
					>
						{busy ? <Loader2 size={14} className="animate-spin" /> : null}
						{busy ? "Setting up…" : "Connect"}
					</button>
				</div>
				{error ? <pre className="mt-4 max-h-48 overflow-auto bg-red/10 p-3 font-mono text-[11px] whitespace-pre-wrap ring-1 ring-red/40">{error}</pre> : null}
			</div>
		</div>
	);
}

function openShell(vmid?: number): void {
	const settings = useSettings.getState().settings;
	const workspaceId = activeWorkspaceIdOf(settings ?? null);
	if (!workspaceId) {
		useUi.getState().toast("Pin a folder first; terminals open in a workspace.", "error");
		return;
	}
	revealPanel("terminal");
	void useTerminals.getState().open(workspaceId, vmid ? "ssh-ct" : "ssh-pve", vmid);
}

function Header({
	overview,
	loading,
	error,
	onRefresh,
	onDisconnected,
}: {
	readonly overview: ServerOverview | null;
	readonly loading: boolean;
	readonly error: string | null;
	readonly onRefresh: () => void;
	readonly onDisconnected: () => void;
}): React.JSX.Element {
	const status = overview?.status;
	const hostAction = async (action: "reboot" | "shutdown"): Promise<void> => {
		const result = await window.teez.server.hostAction(action);
		if (result.ok) useUi.getState().toast(action === "reboot" ? "Rebooting the host…" : "Shutting the host down…", "success");
		else if (result.reason !== "cancelled") useUi.getState().toast(result.reason, "error");
	};
	return (
		<header className="flex flex-wrap items-end justify-between gap-4">
			<div>
				<p className="glow-text font-condensed text-xs uppercase tracking-[0.3em] text-red-hot">Proxmox VE · {status?.pveversion.split("/")[1] ?? "…"}</p>
				<h1 className="font-display text-6xl leading-none tracking-wide">{overview?.node.toUpperCase() ?? "SERVER"}</h1>
				<p className="mt-1 font-mono text-[11px] text-muted">
					{status ? `${status.cpuinfo.model} · ${status.cpuinfo.cpus} threads · up ${duration(status.uptime)} · kernel ${status.kversion.split(" ")[1] ?? ""}` : ""}
				</p>
			</div>
			<div className="flex items-center gap-1">
				{error ? <span className="mr-2 max-w-md truncate font-mono text-[11px] text-red-hot" title={error}>{error}</span> : null}
				{loading ? <Loader2 size={13} className="mr-1 animate-spin text-muted" /> : null}
				<IconButton label="Refresh" onClick={onRefresh}>
					<RefreshCw size={15} />
				</IconButton>
				<IconButton label="SSH into the host (terminal)" onClick={() => openShell()}>
					<TerminalSquare size={15} />
				</IconButton>
				<IconButton label="Reboot the host" onClick={() => void hostAction("reboot")}>
					<RotateCcw size={15} />
				</IconButton>
				<IconButton label="Shut the host down" onClick={() => void hostAction("shutdown")} className="hover:!text-red">
					<Power size={15} />
				</IconButton>
				<IconButton
					label="Disconnect TeezOS from this server"
					onClick={() => {
						void window.teez.server.disconnect().then(onDisconnected);
					}}
				>
					<Unplug size={15} />
				</IconButton>
			</div>
		</header>
	);
}

function Sparkline({ points, color, max }: { readonly points: readonly number[]; readonly color: string; readonly max?: number }): React.JSX.Element {
	const top = max ?? Math.max(...points, 1e-9);
	const path = points
		.map((value, index) => `${(index / Math.max(1, points.length - 1)) * 100},${30 - (Math.min(value, top) / top) * 28}`)
		.join(" ");
	return (
		<svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-10 w-full">
			<polyline points={`0,30 ${path} 100,30`} fill={`${color}22`} stroke="none" />
			<polyline points={path} fill="none" stroke={color} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
		</svg>
	);
}

function Tile({
	label,
	value,
	sub,
	children,
	tone = "text-text",
}: {
	readonly label: string;
	readonly value: string;
	readonly sub?: string;
	readonly children?: React.ReactNode;
	readonly tone?: string;
}): React.JSX.Element {
	return (
		<div className="cut-corner bg-surface p-4 ring-1 ring-border">
			<p className="font-condensed text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">{label}</p>
			<p className={`mt-1 font-display text-4xl leading-none tracking-wide ${tone}`}>{value}</p>
			{sub ? <p className="mt-1 font-mono text-[10.5px] text-muted">{sub}</p> : null}
			{children ? <div className="mt-2">{children}</div> : null}
		</div>
	);
}

function series(rrd: readonly RrdPoint[], pick: (p: RrdPoint) => number | undefined): number[] {
	return rrd.map(pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function Health({ overview }: { readonly overview: ServerOverview }): React.JSX.Element {
	const { status, rrd, ups } = overview;
	const net = series(rrd, (p) => (p.netin ?? 0) + (p.netout ?? 0));
	const lastIn = rrd.at(-1)?.netin ?? 0;
	const lastOut = rrd.at(-1)?.netout ?? 0;
	return (
		<section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
			<Tile label="CPU" value={`${Math.round(status.cpu * 100)}%`} sub={`load ${status.loadavg.join(" · ")}`}>
				<Sparkline points={series(rrd, (p) => p.cpu)} color="#e8002d" max={1} />
			</Tile>
			<Tile label="Memory" value={`${pct(status.memory.used, status.memory.total)}%`} sub={`${gb(status.memory.used)} of ${gb(status.memory.total)}`}>
				<Sparkline points={series(rrd, (p) => p.memused)} color="#f5a524" max={status.memory.total} />
			</Tile>
			<Tile label="Network" value={rate(lastIn + lastOut)} sub={`in ${rate(lastIn)} · out ${rate(lastOut)}`}>
				<Sparkline points={net} color="#75beff" />
			</Tile>
			<Tile label="Root disk" value={`${pct(status.rootfs.used, status.rootfs.total)}%`} sub={`${gb(status.rootfs.used)} of ${gb(status.rootfs.total)}`}>
				<Bar used={status.rootfs.used} total={status.rootfs.total} />
			</Tile>
			<Tile
				label="UPS"
				value={ups ? `${ups.charge ?? "?"}%` : "—"}
				tone={ups && ups.status.includes("OB") ? "text-[#f5a524]" : ups && ups.status.includes("LB") ? "text-red" : "text-text"}
				sub={ups ? `${ups.status.includes("OL") ? "on mains" : ups.status.includes("OB") ? "ON BATTERY" : ups.status} · load ${ups.load ?? "?"}% · ${ups.inputVoltage ?? "?"} V in` : "NUT not reachable on 3493"}
			>
				<div className="flex items-center gap-2 font-mono text-[10px] text-muted">
					<BatteryCharging size={13} className={ups?.status.includes("OL") ? "text-[#73c991]" : "text-[#f5a524]"} />
					{ups?.batteryVoltage ? `battery ${ups.batteryVoltage} V` : ""}
				</div>
			</Tile>
		</section>
	);
}

function Bar({ used, total, color = "#e8002d" }: { readonly used: number; readonly total: number; readonly color?: string }): React.JSX.Element {
	const percent = pct(used, total);
	return (
		<div className="h-1.5 w-full bg-border">
			<div className="h-full" style={{ width: `${percent}%`, background: percent > 90 ? "#ff3b5c" : percent > 75 ? "#f5a524" : color }} />
		</div>
	);
}

function Guests({ overview, onChanged }: { readonly overview: ServerOverview; readonly onChanged: () => void }): React.JSX.Element {
	const [busy, setBusy] = useState<string | null>(null);
	const backupStore = useMemo(
		() => overview.storage.find((s) => s.content.split(",").includes("backup") && s.storage !== "local")?.storage ?? "local",
		[overview.storage],
	);

	const act = async (guest: Guest, action: "start" | "stop" | "shutdown" | "reboot"): Promise<void> => {
		setBusy(`${guest.vmid}:${action}`);
		const result = await window.teez.server.guestAction(guest.type, guest.vmid, action);
		setBusy(null);
		if (result.ok) {
			useUi.getState().toast(`${action} ${guest.name} sent`, "success");
			onChanged();
		} else if (result.reason !== "cancelled") useUi.getState().toast(result.reason, "error");
	};

	const backup = async (guest: Guest): Promise<void> => {
		setBusy(`${guest.vmid}:backup`);
		const result = await window.teez.server.backupNow(guest.vmid, backupStore);
		setBusy(null);
		if (result.ok) useUi.getState().toast(`Backup of ${guest.name} started → ${backupStore}`, "success");
		else if (result.reason !== "cancelled") useUi.getState().toast(result.reason, "error");
	};

	return (
		<section className="mt-8">
			<h2 className="font-condensed text-xs font-semibold uppercase tracking-[0.25em] text-muted">Guests · {overview.guests.length}</h2>
			<div className="mt-3 overflow-x-auto">
				<table className="w-full min-w-[900px] border-collapse text-[13px]">
					<thead>
						<tr className="border-b border-border text-left font-condensed text-[11px] uppercase tracking-wider text-muted">
							<th className="py-2 pr-3 font-semibold">ID</th>
							<th className="py-2 pr-3 font-semibold">Name</th>
							<th className="py-2 pr-3 font-semibold">State</th>
							<th className="py-2 pr-3 font-semibold">CPU</th>
							<th className="w-44 py-2 pr-3 font-semibold">Memory</th>
							<th className="w-36 py-2 pr-3 font-semibold">Disk</th>
							<th className="py-2 pr-3 font-semibold">Uptime</th>
							<th className="py-2 text-right font-semibold">Actions</th>
						</tr>
					</thead>
					<tbody>
						{overview.guests.map((guest) => {
							const running = guest.status === "running";
							return (
								<tr key={guest.vmid} className="border-b border-border/50 hover:bg-white/[0.02]">
									<td className="py-2 pr-3 font-mono text-[12px] text-red">{guest.vmid}</td>
									<td className="py-2 pr-3">
										<span className="flex items-center gap-2">
											{guest.type === "lxc" ? <Box size={13} className="text-muted" /> : <Monitor size={13} className="text-muted" />}
											{guest.name}
										</span>
										{guest.ips && guest.ips.length > 0 ? (
											<button
												type="button"
												title="Copy the address"
												onClick={() => {
													void navigator.clipboard.writeText(guest.ips?.[0] ?? "");
													useUi.getState().toast(`Copied ${guest.ips?.[0] ?? ""}`);
												}}
												className="ml-5 font-mono text-[10px] text-muted hover:text-text"
											>
												{guest.ips.join(" · ")}
											</button>
										) : null}
									</td>
									<td className="py-2 pr-3">
										<span className="flex items-center gap-1.5 font-mono text-[11px]">
											<span className={`h-2 w-2 rounded-full ${running ? "bg-[#22c55e]" : "bg-muted"}`} />
											{guest.status}
										</span>
									</td>
									<td className="py-2 pr-3 font-mono text-[11px]">{running ? `${(guest.cpu * 100).toFixed(1)}%` : "—"} <span className="text-muted">/{guest.cpus}</span></td>
									<td className="py-2 pr-3">
										<Bar used={guest.mem} total={guest.maxmem} color="#f5a524" />
										<span className="font-mono text-[10px] text-muted">{gb(guest.mem)} / {gb(guest.maxmem)}</span>
									</td>
									<td className="py-2 pr-3">
										<Bar used={guest.disk} total={guest.maxdisk} color="#75beff" />
										<span className="font-mono text-[10px] text-muted">{gb(guest.disk)} / {gb(guest.maxdisk)}</span>
									</td>
									<td className="py-2 pr-3 font-mono text-[11px] text-muted">{duration(guest.uptime)}</td>
									<td className="py-2">
										<div className="flex justify-end gap-0.5">
											{busy?.startsWith(`${guest.vmid}:`) ? <Loader2 size={14} className="m-1.5 animate-spin text-muted" /> : null}
											{running ? (
												<>
													{guest.type === "lxc" ? (
														<IconButton label="Shell inside (terminal)" onClick={() => openShell(guest.vmid)}>
															<TerminalSquare size={14} />
														</IconButton>
													) : null}
													<IconButton label="Reboot" onClick={() => void act(guest, "reboot")}>
														<RotateCcw size={14} />
													</IconButton>
													<IconButton label="Shut down" onClick={() => void act(guest, "shutdown")}>
														<Power size={14} />
													</IconButton>
													<IconButton label="Stop (hard)" onClick={() => void act(guest, "stop")}>
														<Square size={13} />
													</IconButton>
												</>
											) : (
												<IconButton label="Start" onClick={() => void act(guest, "start")}>
													<Play size={14} />
												</IconButton>
											)}
											<IconButton label={`Back up now → ${backupStore}`} onClick={() => void backup(guest)}>
												<Archive size={14} />
											</IconButton>
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function Storage({ overview }: { readonly overview: ServerOverview }): React.JSX.Element {
	return (
		<section>
			<h2 className="font-condensed text-xs font-semibold uppercase tracking-[0.25em] text-muted">Storage</h2>
			<div className="mt-3 space-y-3">
				{overview.zfs.map((pool) => (
					<div key={pool.name} className="cut-corner bg-surface p-3 ring-1 ring-border">
						<div className="flex items-center justify-between text-[13px]">
							<span className="flex items-center gap-2">
								<HardDrive size={14} className="text-muted" /> ZFS pool <span className="font-mono">{pool.name}</span>
							</span>
							<span className={`font-mono text-[11px] ${pool.health === "ONLINE" ? "text-[#73c991]" : "text-red"}`}>{pool.health}</span>
						</div>
						<div className="mt-2">
							<Bar used={pool.alloc} total={pool.size} color="#73c991" />
						</div>
						<p className="mt-1 font-mono text-[10px] text-muted">
							{gb(pool.alloc)} used of {gb(pool.size)} · {gb(pool.free)} free · frag {pool.frag}%
						</p>
					</div>
				))}
				{overview.storage
					.filter((s) => s.total > 0)
					.map((s) => (
						<div key={s.storage}>
							<div className="flex justify-between text-[13px]">
								<span>
									{s.storage} <span className="font-mono text-[10px] text-muted">{s.type} · {s.content}</span>
								</span>
								<span className="font-mono text-[11px] text-muted">
									{gb(s.used)} / {gb(s.total)}
								</span>
							</div>
							<div className="mt-1">
								<Bar used={s.used} total={s.total} />
							</div>
						</div>
					))}
			</div>
		</section>
	);
}

function Backups({ overview }: { readonly overview: ServerOverview }): React.JSX.Element {
	const names = new Map(overview.guests.map((g) => [g.vmid, g.name]));
	return (
		<section>
			<h2 className="font-condensed text-xs font-semibold uppercase tracking-[0.25em] text-muted">Backups</h2>
			<div className="mt-3 space-y-1.5">
				{overview.backupJobs.map((job) => (
					<p key={job.id} className="font-mono text-[11px]">
						<span className={job.enabled ? "text-[#73c991]" : "text-muted"}>●</span> job <span className="text-text">{job.id}</span> · {job.schedule} → {job.storage}
						{job["next-run"] ? <span className="text-muted"> · next {new Date(job["next-run"] * 1000).toLocaleString()}</span> : null}
					</p>
				))}
			</div>
			<table className="mt-3 w-full text-[12.5px]">
				<tbody>
					{overview.backups.slice(0, 12).map((b) => {
						const vmid = b.vmid ?? Number(/vzdump-\w+-(\d+)-/.exec(b.volid)?.[1] ?? 0);
						return (
							<tr key={b.volid} className="border-b border-border/40">
								<td className="py-1 pr-3 font-mono text-[11px] text-red-hot">{vmid || "?"}</td>
								<td className="py-1 pr-3">{names.get(vmid) ?? ""}</td>
								<td className="py-1 pr-3 font-mono text-[11px] text-muted">{new Date(b.ctime * 1000).toLocaleString()}</td>
								<td className="py-1 text-right font-mono text-[11px] text-muted">{gb(b.size)}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{overview.backups.length === 0 ? <p className="mt-2 font-mono text-[11px] text-muted">No backups yet.</p> : null}
		</section>
	);
}

function Tasks({ overview }: { readonly overview: ServerOverview }): React.JSX.Element {
	return (
		<section className="mt-8 pb-10">
			<h2 className="font-condensed text-xs font-semibold uppercase tracking-[0.25em] text-muted">Recent tasks</h2>
			<table className="mt-3 w-full text-[12.5px]">
				<tbody>
					{overview.tasks.slice(0, 15).map((task) => (
						<tr key={task.upid} className="border-b border-border/40">
							<td className="py-1 pr-3 font-mono text-[11px] text-muted">{new Date(task.starttime * 1000).toLocaleString()}</td>
							<td className="py-1 pr-3">{task.type}</td>
							<td className="py-1 pr-3 font-mono text-[11px]">{task.id ?? ""}</td>
							<td className="py-1 pr-3 font-mono text-[11px] text-muted">{task.user}</td>
							<td className={`py-1 text-right font-mono text-[11px] ${!task.status ? "text-[#f5a524]" : task.status === "OK" ? "text-[#73c991]" : "text-red"}`}>
								{task.status ?? "running"}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}
