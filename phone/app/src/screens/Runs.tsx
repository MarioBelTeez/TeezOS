import { useState, type ReactNode } from "react";
import type { Job, Run } from "../../../../runner/src/types.ts";
import { postJson } from "../api.ts";
import { usePullToRefresh, useResource } from "../components/hooks.ts";
import { Dot, Empty, ErrorLine, PullHint, ScreenHeader, SectionTitle } from "../components/ui.tsx";
import { ago } from "../format.ts";
import { STATUS_LABEL } from "../runs-view.ts";
import { RunDetail } from "./RunDetail.tsx";

/**
 * Automations from the phone: jobs with Run now, recent runs with their
 * status, and a run's live output. The phone never creates, edits or
 * deletes a job.
 */

type RunsData = { jobs: Job[]; runs: Run[] };

const REFRESH_MS = 10_000;

const tone = (run: Run): "live" | "ok" | "idle" | "bad" => (run.status === "running" ? "live" : run.status === "ok" ? "ok" : run.status === "cancelled" ? "idle" : "bad");

export function Runs({ active, runId, onRun }: { active: boolean; runId: string | null; onRun: (id: string | null) => void }): ReactNode {
	const runs = useResource<RunsData>("/api/runs", active && runId === null, REFRESH_MS);
	const pull = usePullToRefresh(runs.reload);
	const [starting, setStarting] = useState<string | null>(null);
	const [failure, setFailure] = useState<{ text: string; offline: boolean } | null>(null);

	if (runId !== null) {
		const run = runs.data?.runs.find((r) => r.id === runId);
		const job = runs.data?.jobs.find((j) => j.id === run?.jobId) ?? null;
		return <RunDetail runId={runId} job={job} active={active} onBack={() => onRun(null)} />;
	}

	const runNow = async (job: Job): Promise<void> => {
		setStarting(job.id);
		const result = await postJson<Run>(`/api/jobs/${job.id}/run`, {});
		setStarting(null);
		if (result.ok) onRun(result.data.id);
		else setFailure({ text: result.error, offline: result.offline });
	};

	return (
		<section className="flex h-full flex-col">
			<ScreenHeader title="Runs" />
			<div className="scroll-y safe-x min-h-0 flex-1 pb-6" {...pull.handlers}>
				<PullHint state={pull.state} />
				{runs.error ? <ErrorLine text={runs.error.text} offline={runs.error.offline} /> : null}
				{failure ? <ErrorLine text={failure.text} offline={failure.offline} /> : null}
				<SectionTitle>Jobs</SectionTitle>
				{runs.data && runs.data.jobs.length === 0 ? <Empty>No jobs on the runner.</Empty> : null}
				<ul>
					{runs.data?.jobs.map((job) => (
						<li key={job.id} className="flex items-center gap-2 border-b border-border py-2">
							<div className="min-w-0 flex-1">
								<p className="truncate text-[17px]">{job.name}</p>
								<p className="font-mono text-[12px] text-muted">
									{job.engine === "claude" ? "Claude" : "Antigravity"} · {job.schedule || "manual"}
									{job.enabled ? "" : " · off"}
								</p>
							</div>
							<button type="button" disabled={starting !== null} onClick={() => void runNow(job)} className="btn-hot h-11 min-w-24 px-3 font-display text-[18px] tracking-wider">
								{starting === job.id ? "…" : "Run now"}
							</button>
						</li>
					))}
				</ul>
				<SectionTitle>Recent runs</SectionTitle>
				{runs.data && runs.data.runs.length === 0 ? <Empty>No runs yet.</Empty> : null}
				<ul>
					{runs.data?.runs.map((run) => (
						<li key={run.id}>
							<button type="button" onClick={() => onRun(run.id)} className="flex min-h-14 w-full items-center gap-2 border-b border-border py-2 text-left">
								<Dot tone={tone(run)} />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[17px]">{run.jobName}</span>
									<span className="font-mono text-[12px] text-muted">
										{STATUS_LABEL[run.status]} · {run.trigger} · {ago(run.startedAt)}
									</span>
								</span>
								<span aria-hidden className="text-muted">
									›
								</span>
							</button>
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}
