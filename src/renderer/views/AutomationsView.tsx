import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleX, Clock, KeyRound, Loader2, Play, Plus, RefreshCw, Square, Trash2, Unplug } from "lucide-react";
import type { JobView, RunItem } from "../../main/ipc/automations.ts";
import type { Engine, Health, Permission, Run } from "../../../runner/src/types.ts";
import { addNotice, addUserMessage, EMPTY_CHAT, reduceChat, type Card } from "../chat/reduce.ts";
import { CardView, type CardActions } from "../chat/Cards.tsx";
import { activeWorkspaceIdOf, useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { useTerminals } from "../terminal/TerminalDock.tsx";
import { IconButton } from "../shell/IconButton.tsx";
import { revealPanel } from "../shell/dock-actions.ts";

/**
 * Jobs that run Claude Code or Antigravity on the always-on server: on a
 * schedule or on demand, read-only unless a job says otherwise, each run shown
 * as a chat.
 */

type Draft = {
	name: string;
	engine: Engine;
	schedule: string;
	enabled: boolean;
	cwd: string;
	prompt: string;
	model: string;
	permission: Permission;
	timeoutMinutes: number;
	gitPull: boolean;
	commitMessage: string;
};

const SCHEDULES: readonly { readonly label: string; readonly cron: string }[] = [
	{ label: "Manual only", cron: "" },
	{ label: "Every hour", cron: "0 * * * *" },
	{ label: "Every morning at 07:30", cron: "30 7 * * *" },
	{ label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
	{ label: "Every evening at 22:00", cron: "0 22 * * *" },
	{ label: "Mondays at 08:00", cron: "0 8 * * 1" },
	{ label: "Fridays at 18:00", cron: "0 18 * * 5" },
	{ label: "1st of the month at 09:00", cron: "0 9 1 * *" },
];

const PERMISSIONS: readonly { readonly id: Permission; readonly label: string; readonly hint: string }[] = [
	{ id: "read-only", label: "Read only", hint: "Reads and searches the folder. No web, changes nothing." },
	{ id: "research", label: "Read + web", hint: "Also searches and fetches the web. Changes nothing." },
	{ id: "edit", label: "Can edit files", hint: "Reads and edits files in the folder; no shell commands." },
	{ id: "full", label: "Full", hint: "Every tool, shell included, without asking. Only for folders you can afford to lose." },
];

const CLAUDE_MODELS: readonly { readonly id: string; readonly label: string }[] = [
	{ id: "opus", label: "Opus" },
	{ id: "sonnet", label: "Sonnet" },
	{ id: "haiku", label: "Haiku" },
];

/** What a permission level means for Antigravity, where it differs from Claude. */
const AGY_HINTS: Partial<Record<Permission, string>> = {
	"read-only": "Reads the folder; no edits, page fetches or commands. Its web search cannot be switched off, but it only sends queries to Google.",
	research: "Also fetches web pages. Changes nothing, no commands.",
	edit: "Reads and edits files in the folder; no page fetches, no commands.",
};

function templates(vault: string): readonly { readonly label: string; readonly draft: Partial<Draft> }[] {
	return [
		{
			label: "Morning vault digest",
			draft: {
				name: "Morning vault digest",
				schedule: "30 7 * * *",
				cwd: vault,
				gitPull: true,
				permission: "read-only",
				prompt:
					"You are reading the user's TeezMind vault (an Obsidian vault; see CLAUDE.md). Write a short morning digest: (1) what changed in the vault in the last 24 hours (run no commands; read work/Index.md, brain/North Star.md and the notes modified most recently), (2) open tasks that look urgent or overdue, with the note they are in, (3) one suggested focus for today grounded in the North Star. Plain, short sentences. Under 250 words.",
			},
		},
		{
			label: "Weekly vault audit",
			draft: {
				name: "Weekly vault audit",
				schedule: "0 8 * * 1",
				cwd: vault,
				gitPull: true,
				permission: "read-only",
				prompt:
					"Audit the user's TeezMind vault for maintenance problems and report them as a checklist, each item with the note path: notes with no wikilinks, wikilinks that point to notes that do not exist, notes in work/active whose frontmatter status is completed (should be archived), notes missing a description in their frontmatter, and thinking/ notes older than two weeks. Do not change anything.",
			},
		},
		{
			label: "Stale work check",
			draft: {
				name: "Stale work check",
				schedule: "0 18 * * 5",
				cwd: vault,
				gitPull: true,
				permission: "read-only",
				prompt:
					"List every note in work/active of the user's vault that has not been touched in more than 14 days (use the date and the content), with one line each on where it stands and the obvious next step. End with the three most important to pick up next week.",
			},
		},
	];
}

function describeCron(cron: string): string {
	if (!cron) return "manual";
	return SCHEDULES.find((s) => s.cron === cron)?.label.toLowerCase() ?? cron;
}

function when(timestamp: number | null): string {
	if (!timestamp) return "—";
	const diff = timestamp - Date.now();
	const minutes = Math.round(Math.abs(diff) / 60_000);
	const text = minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
	return diff > 0 ? `in ${text}` : `${text} ago`;
}

function StatusDot({ status }: { readonly status: Run["status"] | undefined }): React.JSX.Element {
	if (status === "running") return <Loader2 size={12} className="animate-spin text-[#f5a524]" />;
	if (status === "ok") return <CircleCheck size={12} className="text-[#73c991]" />;
	if (!status) return <Clock size={12} className="text-muted" />;
	return <CircleX size={12} className={status === "cancelled" ? "text-muted" : "text-red"} />;
}

export function AutomationsView(): React.JSX.Element {
	const [configured, setConfigured] = useState<boolean | null>(null);
	const [health, setHealth] = useState<Health | null>(null);
	const [jobs, setJobs] = useState<JobView[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | "new" | null>(null);
	const [openRun, setOpenRun] = useState<string | null>(() => {
		const pending = useUi.getState().pendingRun;
		if (pending) useUi.getState().setPendingRun(null);
		return pending;
	});
	const pendingRun = useUi((s) => s.pendingRun);

	useEffect(() => {
		if (!pendingRun) return;
		setSelected(null);
		setOpenRun(pendingRun);
		useUi.getState().setPendingRun(null);
	}, [pendingRun]);

	const load = useCallback(async () => {
		const [h, j] = await Promise.all([window.teez.automations.health(), window.teez.automations.jobs()]);
		if (!h.ok) {
			if (h.reason === "not-configured") setConfigured(false);
			else setError(h.reason);
			return;
		}
		setError(null);
		setHealth(h.value);
		if (j.ok) setJobs(j.value);
	}, []);

	useEffect(() => {
		void window.teez.automations.status().then((s) => {
			setConfigured(s.configured);
			if (s.configured) void load();
		});
	}, [load]);

	useEffect(() => {
		if (!configured) return;
		const timer = setInterval(() => void load(), 10_000);
		return () => clearInterval(timer);
	}, [configured, load]);

	if (configured === null) return <div className="flex-1" />;
	if (!configured) return <Connect onDone={() => { setConfigured(true); void load(); }} />;

	const job = jobs.find((j) => j.id === selected) ?? null;

	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<aside className="flex w-80 shrink-0 flex-col border-r border-border bg-surface">
				<RunnerCard
					health={health}
					error={error}
					onRefresh={() => void load()}
					onDisconnected={() => {
						setHealth(null);
						setJobs([]);
						setConfigured(false);
					}}
				/>
				<div className="flex items-center justify-between border-b border-border px-3 py-2">
					<h2 className="font-condensed text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">Jobs · {jobs.length}</h2>
					<button
						type="button"
						onClick={() => {
							setSelected("new");
							setOpenRun(null);
						}}
						className="flex items-center gap-1 cut-corner bg-red px-2.5 py-0.5 font-condensed text-[11px] font-semibold uppercase tracking-wider"
					>
						<Plus size={12} /> New job
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{jobs.map((j) => (
						<button
							key={j.id}
							type="button"
							onClick={() => {
								setSelected(j.id);
								setOpenRun(null);
							}}
							className={`block w-full border-l-2 px-3 py-2 text-left hover:bg-white/[0.03] ${selected === j.id ? "border-red bg-red/5" : "border-transparent"}`}
						>
							<p className="flex items-center gap-2 text-[13.5px]">
								<StatusDot status={j.lastRun?.status} />
								<span className="truncate">{j.name}</span>
								{!j.enabled ? <span className="ml-auto font-mono text-[9px] text-muted">off</span> : null}
							</p>
							<p className="mt-0.5 pl-5 font-mono text-[10px] text-muted">
								{describeCron(j.schedule)}
								{j.nextRun ? ` · next ${when(j.nextRun)}` : ""}
								{j.lastRun ? ` · last ${when(j.lastRun.startedAt)}` : ""}
							</p>
						</button>
					))}
					{jobs.length === 0 ? (
						<p className="p-4 font-mono text-[11px] leading-relaxed text-muted">
							No jobs yet. Start from a template: a morning digest of the vault, a weekly audit, a stale-work check.
						</p>
					) : null}
				</div>
			</aside>
			<div className="min-w-0 flex-1">
				{selected === "new" ? (
					<JobEditor
						key="new"
						job={null}
						health={health}
						onSaved={(saved) => {
							void load();
							setSelected(saved.id);
						}}
					/>
				) : job ? (
					<JobDetail key={job.id} job={job} health={health} openRun={openRun} setOpenRun={setOpenRun} onChanged={() => void load()} onDeleted={() => { setSelected(null); void load(); }} />
				) : openRun ? (
					<RunView runId={openRun} />
				) : (
					<div className="flex h-full flex-col items-center justify-center gap-2">
						<p className="font-display text-5xl tracking-wider text-muted/50">AUTOMATIONS</p>
						<p className="font-mono text-[11px] text-muted">Claude Code on {health?.hostname ?? "the server"}, around the clock.</p>
					</div>
				)}
			</div>
		</div>
	);
}

function Connect({ onDone }: { readonly onDone: () => void }): React.JSX.Element {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [vmid, setVmid] = useState(104);
	const run = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		const result = await window.teez.automations.connect("pve", vmid);
		setBusy(false);
		if (result.ok) {
			useUi.getState().toast(`Runner connected at ${result.value}`, "success");
			onDone();
		} else setError(result.reason);
	};
	return (
		<div className="flex flex-1 items-center justify-center p-10">
			<div className="max-w-xl">
				<p className="glow-text font-condensed text-xs uppercase tracking-[0.3em] text-red-hot">Automations</p>
				<h1 className="font-display text-5xl tracking-wide">CONNECT THE RUNNER</h1>
				<p className="mt-3 text-[14px] leading-relaxed text-[#d8cdd2]">
					teez-runner lives in its own container on the Proxmox host and runs Claude Code jobs on a schedule. TeezOS reads its
					address, API token and certificate through <span className="font-mono text-text">ssh pve</span> — nothing to copy by
					hand — and pins the certificate.
				</p>
				<div className="mt-6 flex items-center gap-2">
					<span className="font-mono text-[12px] text-muted">container</span>
					<input
						type="number"
						value={vmid}
						onChange={(event) => setVmid(Number(event.target.value))}
						className="w-24 bg-surface px-2 py-1.5 font-mono text-[13px] text-text outline-none ring-1 ring-border focus:glow"
					/>
					<button type="button" disabled={busy} onClick={() => void run()} className="cut-corner flex items-center gap-2 bg-red px-5 py-1.5 font-condensed text-sm uppercase tracking-wider disabled:opacity-60">
						{busy ? <Loader2 size={14} className="animate-spin" /> : null}
						{busy ? "Connecting…" : "Connect"}
					</button>
				</div>
				{error ? <pre className="mt-4 max-h-48 overflow-auto bg-red/10 p-3 font-mono text-[11px] whitespace-pre-wrap ring-1 ring-red/40">{error}</pre> : null}
			</div>
		</div>
	);
}

function RunnerCard({
	health,
	error,
	onRefresh,
	onDisconnected,
}: {
	readonly health: Health | null;
	readonly error: string | null;
	readonly onRefresh: () => void;
	readonly onDisconnected: () => void;
}): React.JSX.Element {
	const [token, setToken] = useState("");
	const [showToken, setShowToken] = useState(false);
	const openSetupToken = (): void => {
		const workspaceId = activeWorkspaceIdOf(useSettings.getState().settings);
		if (!workspaceId) return;
		revealPanel("terminal");
		void useTerminals.getState().open(workspaceId, "claude-setup-token");
		useUi.getState().toast("Log in in the browser, copy the sk-ant-… token, then paste it in Automations.");
	};
	const save = async (): Promise<void> => {
		const result = await window.teez.automations.setClaudeToken(token.trim());
		if (result.ok) {
			setToken("");
			setShowToken(false);
			useUi.getState().toast("Claude token saved on the runner.", "success");
			onRefresh();
		} else useUi.getState().toast(result.reason, "error");
	};
	return (
		<div className="border-b border-border p-3">
			<div className="flex items-center justify-between">
				<p className="flex items-center gap-2 text-[13px]">
					<span className={`h-2 w-2 rounded-full ${health ? "bg-[#22c55e]" : error ? "bg-red" : "bg-muted"}`} />
					teez-runner {health ? `on ${health.hostname}` : ""}
				</p>
				<div className="flex">
					<IconButton label="Refresh" onClick={onRefresh}>
						<RefreshCw size={13} />
					</IconButton>
					<IconButton label="Disconnect" onClick={() => void window.teez.automations.disconnect().then(onDisconnected)}>
						<Unplug size={13} />
					</IconButton>
				</div>
			</div>
			{error ? <p className="mt-1 font-mono text-[10px] text-red">{error}</p> : null}
			{health ? (
				<p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">
					v{health.version} · {health.timezone} · {health.running} running
					<br />
					{health.claude.installed ? `claude ${health.claude.version.split(" ")[0]}` : "claude not installed"} ·{" "}
					<span className={health.claude.hasToken ? "text-[#73c991]" : "text-[#f5a524]"}>{health.claude.hasToken ? "logged in" : "no token yet"}</span>
					{health.antigravity ? (
						<>
							<br />
							{health.antigravity.installed ? `agy ${health.antigravity.version}` : "agy not installed"} ·{" "}
							<span className={health.antigravity.loggedIn ? "text-[#73c991]" : "text-[#f5a524]"}>{health.antigravity.loggedIn ? "logged in" : "not logged in"}</span>
						</>
					) : null}
				</p>
			) : null}
			{health && (!health.claude.hasToken || showToken) ? (
				<div className="mt-2 space-y-1.5 bg-bg p-2 ring-1 ring-border">
					<p className="font-mono text-[10px] leading-relaxed text-muted">
						Jobs run on your Claude subscription. Get a long-lived token on this PC, then paste it here — it is stored only on the runner.
					</p>
					<button type="button" onClick={openSetupToken} className="flex items-center gap-1.5 font-condensed text-[11px] uppercase tracking-wider text-red hover:underline">
						<KeyRound size={12} /> Run claude setup-token
					</button>
					<div className="flex gap-1">
						<input
							type="password"
							value={token}
							onChange={(event) => setToken(event.target.value)}
							placeholder="sk-ant-oat01-…"
							className="min-w-0 flex-1 bg-surface px-2 py-1 font-mono text-[11px] text-text outline-none ring-1 ring-border focus:glow"
						/>
						<button type="button" disabled={!token.trim()} onClick={() => void save()} className="cut-corner bg-red px-2.5 font-condensed text-[11px] uppercase disabled:opacity-40">
							Save
						</button>
					</div>
				</div>
			) : health ? (
				<button type="button" onClick={() => setShowToken(true)} className="mt-1 font-mono text-[10px] text-muted hover:text-text">
					replace Claude token
				</button>
			) : null}
		</div>
	);
}

function toDraft(job: JobView | null, health: Health | null): Draft {
	const vault = health?.folders.find((f) => /teezmind$/i.test(f)) ?? health?.workDir ?? "/home/agent/work";
	if (job) {
		const { name, engine, schedule, enabled, cwd, prompt, model, permission, timeoutMinutes, gitPull, commitMessage } = job;
		return { name, engine: engine ?? "claude", schedule, enabled, cwd, prompt, model, permission, timeoutMinutes, gitPull, commitMessage };
	}
	// New jobs go to Antigravity when it is ready: it spares the Claude plan.
	const engine: Engine = health?.antigravity?.loggedIn ? "antigravity" : "claude";
	return { name: "", engine, schedule: "", enabled: true, cwd: vault, prompt: "", model: "", permission: "read-only", timeoutMinutes: 20, gitPull: true, commitMessage: "" };
}

/** The engine's models, plus the job's saved one if the list no longer has it. */
function modelOptions(draft: Draft, health: Health | null): readonly { readonly id: string; readonly label: string }[] {
	const list = draft.engine === "antigravity" ? (health?.antigravity?.models ?? []) : CLAUDE_MODELS;
	return draft.model && !list.some((m) => m.id === draft.model) ? [...list, { id: draft.model, label: draft.model }] : list;
}

function JobEditor({ job, health, onSaved }: { readonly job: JobView | null; readonly health: Health | null; readonly onSaved: (job: JobView) => void }): React.JSX.Element {
	const [draft, setDraft] = useState<Draft>(() => toDraft(job, health));
	const [saving, setSaving] = useState(false);
	const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => setDraft((d) => ({ ...d, [key]: value }));
	const vault = health?.folders.find((f) => /teezmind$/i.test(f)) ?? health?.workDir ?? "/home/agent/work";
	// Custom mode is its own state: an emptied cron field ("") would otherwise
	// read as "Manual only" and the field would vanish mid-edit.
	const [customMode, setCustomMode] = useState(() => !SCHEDULES.some((s) => s.cron === draft.schedule));
	const customSchedule = customMode;

	const save = async (): Promise<void> => {
		setSaving(true);
		const result = await window.teez.automations.saveJob(job?.id ?? null, draft);
		setSaving(false);
		if (result.ok) {
			useUi.getState().toast(job ? "Job saved." : "Job created.", "success");
			onSaved(result.value);
		} else useUi.getState().toast(result.reason, "error");
	};

	return (
		<div className="h-full overflow-y-auto px-8 py-6">
			<div className="max-w-3xl space-y-4">
				{!job ? (
					<div className="flex flex-wrap gap-2">
						{templates(vault).map((t) => (
							<button key={t.label} type="button" onClick={() => {
									setDraft((d) => ({ ...d, ...t.draft }));
									// The picker follows the template's schedule, custom or not.
									setCustomMode(!SCHEDULES.some((s) => s.cron === (t.draft.schedule ?? draft.schedule)));
								}} className="cut-corner bg-surface px-3 py-1 font-condensed text-xs uppercase tracking-wider ring-1 ring-border hover:ring-red/50">
								{t.label}
							</button>
						))}
					</div>
				) : null}
				<Field label="Name">
					<input value={draft.name} onChange={(e) => set("name", e.target.value)} className="input" placeholder="Morning vault digest" />
				</Field>
				<Field label="Prompt" hint="What the agent should do, written as you would in a chat. It runs headless: it cannot ask you anything mid-run.">
					<textarea value={draft.prompt} onChange={(e) => set("prompt", e.target.value)} rows={8} className="input resize-y" />
				</Field>
				<div className="grid gap-4 md:grid-cols-2">
					<Field label="Schedule" hint={customSchedule && draft.schedule ? "Custom cron (minute hour day month weekday)" : undefined}>
						<select
							value={customSchedule ? "__custom" : draft.schedule}
							onChange={(e) => {
								const custom = e.target.value === "__custom";
								setCustomMode(custom);
								set("schedule", custom ? "0 12 * * *" : e.target.value);
							}}
							className="input"
						>
							{SCHEDULES.map((s) => (
								<option key={s.label} value={s.cron}>
									{s.label}
								</option>
							))}
							<option value="__custom">Custom cron…</option>
						</select>
						{customSchedule ? <input value={draft.schedule} onChange={(e) => set("schedule", e.target.value)} className="input mt-1.5 font-mono" /> : null}
					</Field>
					<Field label="Folder on the runner">
						<select value={draft.cwd} onChange={(e) => set("cwd", e.target.value)} className="input font-mono">
							{[...new Set([...(health?.folders ?? []), draft.cwd])].map((f) => (
								<option key={f} value={f}>
									{f}
								</option>
							))}
						</select>
					</Field>
					<Field label="Runs on" hint={draft.engine === "antigravity" ? (health?.antigravity?.loggedIn ? "Your Google account's Antigravity quota." : "Antigravity is not logged in on the runner yet; runs will fail until it is.") : "Your Claude plan (the token saved on the runner)."}>
						<select
							value={draft.engine}
							onChange={(e) => setDraft((d) => ({ ...d, engine: e.target.value as Engine, model: "" }))}
							className="input"
						>
							<option value="claude">Claude</option>
							<option value="antigravity">Antigravity{health?.antigravity?.loggedIn ? "" : " (not logged in)"}</option>
						</select>
					</Field>
					<Field label="Permissions" hint={(draft.engine === "antigravity" ? AGY_HINTS[draft.permission] : undefined) ?? PERMISSIONS.find((p) => p.id === draft.permission)?.hint}>
						<select value={draft.permission} onChange={(e) => set("permission", e.target.value as Permission)} className="input">
							{PERMISSIONS.map((p) => (
								<option key={p.id} value={p.id}>
									{p.label}
								</option>
							))}
						</select>
					</Field>
					<Field label="Model">
						<select value={draft.model} onChange={(e) => set("model", e.target.value)} className="input">
							<option value="">Default</option>
							{modelOptions(draft, health).map((m) => (
								<option key={m.id} value={m.id}>
									{m.label}
								</option>
							))}
						</select>
					</Field>
					<Field label="Time limit (minutes)">
						<input type="number" min={1} max={240} value={draft.timeoutMinutes} onChange={(e) => set("timeoutMinutes", Number(e.target.value))} className="input" />
					</Field>
					<Field label="Before and after">
						<label className="flex items-center gap-2 text-[13px]">
							<input type="checkbox" checked={draft.gitPull} onChange={(e) => set("gitPull", e.target.checked)} className="accent-[#e8002d]" />
							git pull first
						</label>
						<label className="mt-1 flex items-center gap-2 text-[13px]">
							<input type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} className="accent-[#e8002d]" />
							schedule on
						</label>
					</Field>
				</div>
				<Field label="Commit and push afterwards" hint="Leave empty to never commit. Only with Can edit or Full, and the deploy key needs write access.">
					<input value={draft.commitMessage} onChange={(e) => set("commitMessage", e.target.value)} className="input font-mono" placeholder="vault: morning digest (teez-runner)" />
				</Field>
				<button type="button" disabled={saving} onClick={() => void save()} className="cut-corner bg-red px-6 py-2 font-condensed text-sm font-semibold uppercase tracking-wider disabled:opacity-60">
					{saving ? "Saving…" : job ? "Save job" : "Create job"}
				</button>
			</div>
		</div>
	);
}

function Field({ label, hint, children }: { readonly label: string; readonly hint?: string | undefined; readonly children: React.ReactNode }): React.JSX.Element {
	return (
		<label className="block">
			<span className="font-condensed text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">{label}</span>
			<div className="mt-1">{children}</div>
			{hint ? <span className="mt-1 block font-mono text-[10px] text-muted">{hint}</span> : null}
		</label>
	);
}

function JobDetail({
	job,
	health,
	openRun,
	setOpenRun,
	onChanged,
	onDeleted,
}: {
	readonly job: JobView;
	readonly health: Health | null;
	readonly openRun: string | null;
	readonly setOpenRun: (id: string | null) => void;
	readonly onChanged: () => void;
	readonly onDeleted: () => void;
}): React.JSX.Element {
	const [tab, setTab] = useState<"runs" | "edit">("runs");
	const [runs, setRuns] = useState<Run[]>([]);

	const loadRuns = useCallback(async () => {
		const result = await window.teez.automations.runs(job.id);
		if (result.ok) {
			setRuns(result.value);
			if (!openRun && result.value[0]) setOpenRun(result.value[0].id);
		}
	}, [job.id, openRun, setOpenRun]);

	useEffect(() => {
		void loadRuns();
		const timer = setInterval(() => void loadRuns(), 5000);
		return () => clearInterval(timer);
	}, [loadRuns]);

	const runNow = async (): Promise<void> => {
		const result = await window.teez.automations.runJob(job.id);
		if (result.ok) {
			setOpenRun(result.value.id);
			void loadRuns();
			onChanged();
		} else useUi.getState().toast(result.reason, "error");
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-center gap-3 border-b border-border px-6 py-3">
				<div className="min-w-0 flex-1">
					<h1 className="truncate font-display text-3xl tracking-wide">{job.name}</h1>
					<p className="font-mono text-[10.5px] text-muted">
						{describeCron(job.schedule)} {job.nextRun ? `· next ${when(job.nextRun)}` : ""} · {job.engine === "antigravity" ? "antigravity" : "claude"} · {job.permission} · {job.cwd}
					</p>
				</div>
				<button type="button" onClick={() => void runNow()} className="flex items-center gap-1.5 cut-corner bg-red px-4 py-1.5 font-condensed text-xs font-semibold uppercase tracking-wider">
					<Play size={12} /> Run now
				</button>
				<IconButton label="Delete job" onClick={() => void window.teez.automations.deleteJob(job.id, job.name).then((r) => r.ok && onDeleted())}>
					<Trash2 size={15} />
				</IconButton>
			</header>
			<div className="flex border-b border-border px-4">
				{(["runs", "edit"] as const).map((t) => (
					<button key={t} type="button" onClick={() => setTab(t)} className={`relative px-3 py-2 font-condensed text-[11px] font-semibold uppercase tracking-wider ${tab === t ? "text-text" : "text-muted hover:text-text"}`}>
						{t === "runs" ? `Runs · ${runs.length}` : "Edit"}
						{tab === t ? <span className="absolute inset-x-2 bottom-0 h-[2px] bg-red" /> : null}
					</button>
				))}
			</div>
			{tab === "edit" ? (
				<JobEditor job={job} health={health} onSaved={() => { onChanged(); setTab("runs"); }} />
			) : (
				<div className="flex min-h-0 flex-1">
					<div className="w-60 shrink-0 overflow-y-auto border-r border-border">
						{runs.map((run) => (
							<button key={run.id} type="button" onClick={() => setOpenRun(run.id)} className={`block w-full border-l-2 px-3 py-2 text-left hover:bg-white/[0.03] ${openRun === run.id ? "border-red bg-red/5" : "border-transparent"}`}>
								<p className="flex items-center gap-2 text-[12.5px]">
									<StatusDot status={run.status} />
									{new Date(run.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
								</p>
								<p className="pl-5 font-mono text-[10px] text-muted">
									{run.trigger} · {run.status}
									{run.endedAt ? ` · ${Math.round((run.endedAt - run.startedAt) / 1000)}s` : ""}
								</p>
							</button>
						))}
						{runs.length === 0 ? <p className="p-3 font-mono text-[11px] text-muted">No runs yet.</p> : null}
					</div>
					<div className="min-w-0 flex-1">{openRun ? <RunView key={openRun} runId={openRun} /> : null}</div>
				</div>
			)}
		</div>
	);
}

const NO_ACTIONS: CardActions = { onApprove: () => undefined, onOpenFile: () => undefined, onRetry: () => undefined, onLogin: () => undefined };

function foldRun(items: readonly RunItem[]): readonly Card[] {
	let chat = EMPTY_CHAT;
	for (const item of items) {
		if (item.kind === "user") chat = { ...addUserMessage(chat, item.text), running: false };
		else if (item.kind === "notice") chat = addNotice(chat, item.text);
		else chat = reduceChat(chat, item);
	}
	return chat.cards;
}

function RunView({ runId }: { readonly runId: string }): React.JSX.Element {
	const [data, setData] = useState<{ run: Run; items: RunItem[] } | null>(null);
	const cards = useMemo(() => (data ? foldRun(data.items) : []), [data]);

	useEffect(() => {
		let stopped = false;
		let failures = 0;
		const tick = async (): Promise<void> => {
			const result = await window.teez.automations.run(runId);
			if (stopped) return;
			if (!result.ok) {
				// A dropped request is not the end of the run: back off and try again.
				failures += 1;
				if (failures < 30) setTimeout(() => void tick(), Math.min(15_000, 2000 * failures));
				return;
			}
			failures = 0;
			setData(result.value);
			if (result.value.run.status === "running") setTimeout(() => void tick(), 2000);
		};
		void tick();
		return () => {
			stopped = true;
		};
	}, [runId]);

	if (!data) return <p className="p-6 font-mono text-xs text-muted">Loading the run…</p>;
	const { run } = data;
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-3 border-b border-border px-5 py-2 font-mono text-[11px] text-muted">
				<StatusDot status={run.status} />
				<span className="text-text">{run.status}</span>
				<span>{new Date(run.startedAt).toLocaleString()}</span>
				{run.costUsd ? <span>${run.costUsd.toFixed(3)}</span> : null}
				{run.git ? <span>git: {run.git}</span> : null}
				<div className="flex-1" />
				{run.status === "running" ? (
					<button type="button" onClick={() => void window.teez.automations.cancelRun(run.id)} className="flex items-center gap-1 text-red hover:underline">
						<Square size={11} /> stop
					</button>
				) : null}
			</div>
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
				{cards.map((card) => (
					<CardView key={card.id} card={card} agentName="Claude" actions={NO_ACTIONS} />
				))}
				{run.error ? <pre className="bg-red/10 p-3 font-mono text-[11px] whitespace-pre-wrap ring-1 ring-red/40">{run.error}</pre> : null}
				{run.status === "running" ? (
					<p className="flex items-center gap-2 font-mono text-[10px] text-muted">
						<span className="pulse-dot h-1.5 w-1.5 rounded-full bg-red-hot shadow-[0_0_8px_var(--color-glow)]" /> running on the server…
					</p>
				) : null}
			</div>
		</div>
	);
}
