import { useEffect, useMemo, useState } from "react";
import type { UsageWindow } from "../../shared/usage.ts";
import { useUsage } from "../state/usage.ts";
import type { Chat } from "../state/chats.ts";
import { agyLimitRows, barTone, contextSummary, formatPct, formatResetsIn, limitRows, railLayout, weeklyWarning, type BarTone, type ContextSummary } from "./usage-rails.ts";

/**
 * The empty space either side of the composer on a wide window: Claude's plan
 * limits on the left (the 5-hour bar, and a weekly warning from 75 %), this
 * chat's context and cost on the right. Nothing shows when either side lacks
 * room, or when there is nothing to show. A Gemini chat still sees Claude's
 * limits, dimmed: Antigravity reports neither its quota nor its context.
 */

type Layout = { readonly width: number; readonly gap: number; readonly composerWidth: number };

/** How the empty space measures up, kept in step with the window by a ResizeObserver. */
function useRailLayout(row: React.RefObject<HTMLElement | null>, composer: React.RefObject<HTMLElement | null>): Layout | null {
	const [layout, setLayout] = useState<Layout | null>(null);
	useEffect(() => {
		const rowElement = row.current;
		const composerElement = composer.current;
		if (!rowElement || !composerElement) return;
		const measure = (): void => {
			const style = getComputedStyle(rowElement);
			const rowWidth = rowElement.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
			const composerWidth = composerElement.offsetWidth;
			const fit = railLayout(rowWidth, composerWidth);
			setLayout((previous) => {
				if (!fit) return null;
				if (previous && previous.width === fit.width && previous.gap === fit.gap && previous.composerWidth === composerWidth) return previous;
				return { ...fit, composerWidth };
			});
		};
		const observer = new ResizeObserver(measure);
		observer.observe(rowElement);
		observer.observe(composerElement);
		measure();
		return () => observer.disconnect();
	}, [row, composer]);
	return layout;
}

/** The time now, moved on every half minute so "resets in" counts down. */
export function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

const FILL: Readonly<Record<BarTone, string>> = {
	normal: "bg-red",
	warn: "bg-amber",
	hot: "bg-red-hot shadow-[0_0_10px_var(--color-glow)]",
};

const FIGURE: Readonly<Record<BarTone, string>> = {
	normal: "text-text",
	warn: "text-amber",
	hot: "glow-text text-red-hot",
};

export function Meter({ label, window, now, size = "main" }: { readonly label: string; readonly window: UsageWindow; readonly now: number; readonly size?: "main" | "share" }): React.JSX.Element {
	const tone = barTone(window.pct);
	const resets = formatResetsIn(window.resetsAt, now);
	return (
		<div title={size === "share" && resets ? `${label}: ${formatPct(window.pct)} used, ${resets}` : undefined}>
			<div className="flex items-baseline justify-between gap-2 font-condensed text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
				<span>{label}</span>
				<span className={`font-mono tracking-normal ${size === "main" ? "text-[13px]" : "text-[11px]"} ${FIGURE[tone]}`}>{formatPct(window.pct)}</span>
			</div>
			<div
				className={`mt-1 overflow-hidden bg-border/80 ${size === "main" ? "h-1.5" : "h-1"}`}
				role="meter"
				aria-label={`${label} used`}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(window.pct)}
			>
				<div className={`h-full transition-[width] duration-500 ${FILL[tone]}`} style={{ width: `${window.pct}%` }} />
			</div>
			{/* The model's share resets with the week shown above it; its line would only repeat that. */}
			{size === "main" ? (
				<p className="mt-1 truncate font-mono text-[10.5px] text-muted">
					{formatPct(window.pct)} used{resets ? ` · ${resets}` : ""}
				</p>
			) : null}
		</div>
	);
}

function ContextRail({ summary, running, onCompact }: { readonly summary: ContextSummary; readonly running: boolean; readonly onCompact: () => void }): React.JSX.Element {
	if (summary.kind === "unreported") return <p className="truncate font-mono text-[10px] text-muted/80">Context not reported by Antigravity</p>;
	const tone = barTone(summary.pct);
	return (
		<>
			<div className="flex items-baseline justify-between gap-2 font-condensed text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
				<span>Context</span>
				<span className={`font-mono text-[13px] tracking-normal ${FIGURE[tone]}`}>{summary.pct}%</span>
			</div>
			<div className="h-1.5 overflow-hidden bg-border/80" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.pct}>
				<div className={`h-full transition-[width] duration-500 ${FILL[tone]}`} style={{ width: `${summary.pct}%` }} />
			</div>
			<p className="truncate font-mono text-[10.5px] text-muted">
				{summary.used} / {summary.window} · {summary.pct}%
			</p>
			<p className="truncate font-mono text-[10.5px] text-muted">
				Session {summary.cost} · {summary.turns}
			</p>
			{summary.canCompact ? (
				<button
					type="button"
					disabled={running}
					title={running ? "Wait for the turn to finish" : "Summarize the conversation so far to free up context"}
					onClick={onCompact}
					className="cut-corner self-start bg-surface px-2.5 py-1 font-condensed text-[11px] font-semibold uppercase tracking-wider text-muted ring-1 ring-border enabled:hover:text-text enabled:hover:ring-red/50 disabled:opacity-40"
				>
					Compact
				</button>
			) : null}
		</>
	);
}

export function UsageRails({
	row,
	composer,
	chat,
	onCompact,
}: {
	readonly row: React.RefObject<HTMLElement | null>;
	readonly composer: React.RefObject<HTMLElement | null>;
	readonly chat: Chat | null;
	readonly onCompact: () => void;
}): React.JSX.Element | null {
	const usage = useUsage((s) => s.usage);
	const agyUsage = useUsage((s) => s.agyUsage);
	const layout = useRailLayout(row, composer);
	const now = useNow((usage !== null || agyUsage !== null) && layout !== null);
	const agent = chat?.agent ?? "claude";
	const model = chat?.model ?? "";
	const gemini = agent === "agy";
	const rows = useMemo(() => {
		if (gemini && agyUsage) return agyLimitRows(agyUsage, model);
		return usage ? limitRows(usage) : [];
	}, [gemini, agyUsage, usage, model]);
	const weekly = useMemo(() => {
		if (gemini && agyUsage) return null;
		return usage ? weeklyWarning(usage, agent, model) : null;
	}, [gemini, agyUsage, usage, agent, model]);
	const context = chat?.context ?? null;
	const cost = chat?.totalCostUsd ?? 0;
	const turns = chat?.turns ?? 0;
	const summary = useMemo(() => (chat ? contextSummary(agent, context, cost, turns) : null), [chat, agent, context, cost, turns]);
	if (!layout) return null;

	const offset = `calc(50% + ${layout.composerWidth / 2 + layout.gap}px)`;
	const rail = "absolute top-3 flex flex-col gap-2 transition-opacity";
	const dim = gemini && !agyUsage ? "opacity-45" : "";

	return (
		<>
			{rows.length > 0 || weekly ? (
				<aside className={`${rail} ${dim}`} style={{ right: offset, width: layout.width }} title={gemini && agyUsage ? "Antigravity plan usage" : "Claude plan usage"}>
					{rows.map((r) => (
						<Meter key={r.label} label={r.label} window={r.window} now={now} size={r.size} />
					))}
					{weekly ? <p className="truncate font-mono text-[10.5px] text-amber">{weekly}</p> : null}
					{gemini && !agyUsage ? <p className="truncate font-mono text-[10px] text-muted/80">Antigravity quota: loading…</p> : null}
				</aside>
			) : null}
			{summary ? (
				<aside className={`${rail} ${summary.kind === "unreported" ? "opacity-45" : ""}`} style={{ left: offset, width: layout.width }} title="This chat's context">
					<ContextRail summary={summary} running={chat?.running ?? false} onCompact={onCompact} />
				</aside>
			) : null}
		</>
	);
}
