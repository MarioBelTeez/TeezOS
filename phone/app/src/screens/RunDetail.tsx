import { useEffect, useState, type ReactNode } from "react";
import type { Job, Run, RunEvent } from "../../../../runner/src/types.ts";
import { postJson, request } from "../api.ts";
import { Messages } from "../chat/Messages.tsx";
import { Dot, ErrorLine, IconButton, ScreenHeader } from "../components/ui.tsx";
import { ago, duration } from "../format.ts";
import { lastSeq, mergeEvents, runView, STATUS_LABEL } from "../runs-view.ts";

/**
 * One run's live output. The server long-polls (`events?after=`), so the
 * loop asks again as soon as an answer comes, until the run has ended and its
 * last events are in. Cancel shows while it runs.
 */

const RETRY_MS = 3000;

export function RunDetail({ runId, job, active, onBack }: { runId: string; job: Job | null; active: boolean; onBack: () => void }): ReactNode {
	const [run, setRun] = useState<Run | null>(null);
	const [events, setEvents] = useState<RunEvent[]>([]);
	const [failure, setFailure] = useState<{ text: string; offline: boolean } | null>(null);

	useEffect(() => {
		setRun(null);
		setEvents([]);
		if (!active) return;
		let stopped = false;
		let known: RunEvent[] = [];
		const nap = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
		const loop = async (): Promise<void> => {
			while (!stopped) {
				const [state, more] = await Promise.all([request<Run>(`/api/runs/${runId}`), request<RunEvent[]>(`/api/runs/${runId}/events?after=${lastSeq(known)}`)]);
				if (stopped) return;
				if (!state.ok || !more.ok) {
					const bad = !state.ok ? state : more.ok ? null : more;
					if (bad?.status === 404) {
						setFailure({ text: "That run is gone.", offline: false });
						return;
					}
					if (bad) setFailure({ text: bad.error, offline: bad.offline });
					await nap(RETRY_MS);
					continue;
				}
				setFailure(null);
				setRun(state.data);
				known = mergeEvents(known, more.data);
				setEvents(known);
				if (state.data.status !== "running" && more.data.length === 0) return;
			}
		};
		void loop();
		return () => {
			stopped = true;
		};
	}, [runId, active]);

	const cancel = async (): Promise<void> => {
		const result = await postJson(`/api/runs/${runId}/cancel`, {});
		if (!result.ok) setFailure({ text: result.error, offline: result.offline });
	};

	const view = runView(job, events);
	const running = run?.status === "running";
	return (
		<section className="flex h-full flex-col">
			<ScreenHeader
				title={run?.jobName ?? job?.name ?? "Run"}
				left={
					<IconButton label="Back to runs" onClick={onBack}>
						‹ Runs
					</IconButton>
				}
				right={
					running ? (
						<button type="button" onClick={() => void cancel()} className="h-11 border border-red px-3 font-display text-[18px] tracking-wider text-red-hot active:bg-red/20">
							Cancel
						</button>
					) : null
				}
			/>
			<div className="scroll-y safe-x min-h-0 flex-1 pb-6">
				{run ? (
					<p className="mt-2 flex items-center gap-2 font-mono text-[13px] text-muted">
						<Dot tone={running ? "live" : run.status === "ok" ? "ok" : run.status === "cancelled" ? "idle" : "bad"} />
						{STATUS_LABEL[run.status]} · {run.trigger} · {ago(run.startedAt)}
						{run.endedAt ? ` · ${duration((run.endedAt - run.startedAt) / 1000)}` : ""}
					</p>
				) : null}
				{failure ? <ErrorLine text={failure.text} offline={failure.offline} /> : null}
				<Messages cards={view.cards} streamingId={null} running={running} />
				{run?.error ? <ErrorLine text={run.error} /> : null}
				{run?.git ? <p className="font-mono text-[12px] text-muted">git: {run.git}</p> : null}
			</div>
		</section>
	);
}
