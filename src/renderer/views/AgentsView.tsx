import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentTree } from "../state/agent-tree.ts";
import { useSettings } from "../state/settings.ts";
import { AgentCard } from "../agents/AgentCard.tsx";
import { AgentDrawer } from "../agents/AgentDrawer.tsx";
import { childrenOf, visibleRoots, type AgentNode, type AgentTree } from "../agents/tree.ts";

/**
 * Every agent at work, newest first: each chat, the subagents and
 * Antigravity runs it started (nested as they nest), and the server's
 * automation runs. Running edges flow; a card opens its log on the right.
 */

/** The elapsed clocks tick each second while something runs; otherwise often enough to dim and drop old cards. */
const TICK_RUNNING_MS = 1000;
const TICK_IDLE_MS = 15_000;
const POLL_RUNS_MS = 10_000;
/** Where an edge meets a card: the middle of the card's first row (wrapper pt-2 + border + py-2 + half of h-5). */
const ELBOW_Y = 27;
const ELBOW_RADIUS = 8;
const EDGE_WIDTH = 24;
const EDGE_X = 1;

/** On screen: the panel is the visible tab of its group and the window is not minimised. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
	const [inView, setInView] = useState(false);
	const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const observer = new IntersectionObserver((entries) => {
			const last = entries.at(-1);
			if (last) setInView(last.isIntersecting);
		});
		observer.observe(element);
		const onVisibility = (): void => setPageVisible(document.visibilityState === "visible");
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [ref]);
	return inView && pageVisible;
}

function useNow(active: boolean, intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [active, intervalMs]);
	return now;
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * The server's runs, every 10 s while the view is on screen. Each tick asks
 * whether automations are set up, so connecting them while the view is open
 * starts the poll; a tick still waiting on the last one is skipped.
 */
function useAutomationRuns(onScreen: boolean): string | null {
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!onScreen) return;
		let stopped = false;
		let inFlight = false;
		const poll = async (): Promise<void> => {
			if (inFlight) return;
			inFlight = true;
			try {
				const status = await window.teez.automations.status();
				if (stopped || !status.configured) return;
				const result = await window.teez.automations.runs(null);
				if (stopped) return;
				if (result.ok) {
					setError(null);
					useAgentTree.getState().applyRuns(result.value);
				} else setError(result.reason);
			} catch (cause) {
				if (!stopped) setError(reasonOf(cause));
			} finally {
				inFlight = false;
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), POLL_RUNS_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [onScreen]);
	return error;
}

export function AgentsView(): React.JSX.Element {
	const tree = useAgentTree((s) => s.tree);
	const selected = useAgentTree((s) => s.selected);
	const select = useAgentTree((s) => s.select);
	const root = useRef<HTMLDivElement>(null);
	const onScreen = useOnScreen(root);
	const running = useMemo(() => tree.order.filter((id) => tree.nodes[id]?.status === "running").length, [tree]);
	const now = useNow(onScreen, running > 0 ? TICK_RUNNING_MS : TICK_IDLE_MS);
	// The Automations module off: the server's runs are not asked for at all.
	const automationsOn = useSettings((s) => s.settings?.modules.automations.enabled ?? false);
	const runsError = useAutomationRuns(onScreen && automationsOn);
	const roots = useMemo(() => visibleRoots(tree, now), [tree, now]);
	const children = useMemo(() => childrenOf(tree), [tree]);
	const selectedNode = selected ? tree.nodes[selected] : undefined;

	return (
		<div
			ref={root}
			className="relative flex h-full min-h-0 w-full flex-col"
			onKeyDown={(event) => {
				if (event.key === "Escape" && selected) select(null);
			}}
		>
			<header className="border-b border-border px-6 py-3">
				{/* Header and tree share one centred column, so a wide window does not leave the tree in a corner. */}
				<div className="mx-auto flex w-full max-w-3xl items-baseline gap-3">
					<h1 className="glow-text font-display text-3xl tracking-wide">AGENTS</h1>
					<span className="font-mono text-[10.5px] text-muted">
						{running > 0 ? `${running} running` : "idle"}
						{roots.length > 0 ? ` · ${roots.length} shown` : ""}
					</span>
					{runsError ? (
						<span className="ml-auto truncate font-mono text-[10.5px] text-muted" title={runsError}>
							Automations unreachable: {runsError}
						</span>
					) : null}
				</div>
			</header>
			<div className="min-h-0 flex-1 overflow-auto px-6 py-4">
				{roots.length === 0 ? (
					<div className="flex h-full items-center justify-center">
						<p className="max-w-sm text-center font-mono text-[11px] leading-relaxed text-muted">
							No agents running. Subagents and Antigravity runs show up here live.
						</p>
					</div>
				) : (
					<div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
						{roots.map((node) => (
							<Branch key={node.id} node={node} tree={tree} childMap={children} now={now} selected={selected} onSelect={select} />
						))}
					</div>
				)}
			</div>
			{selectedNode ? <AgentDrawer node={selectedNode} now={now} onClose={() => select(null)} /> : null}
		</div>
	);
}

type BranchProps = {
	readonly node: AgentNode;
	readonly tree: AgentTree;
	readonly childMap: Readonly<Record<string, readonly string[]>>;
	readonly now: number;
	readonly selected: string | null;
	readonly onSelect: (id: string) => void;
};

function Branch({ node, tree, childMap, now, selected, onSelect }: BranchProps): React.JSX.Element {
	const kids = (childMap[node.id] ?? []).map((id) => tree.nodes[id]).filter((child): child is AgentNode => !!child);
	// Whether anything from each child on down the list still runs: the trunk below a child leads there.
	const runningFrom = kids.reduceRight<boolean[]>((acc, child) => [child.status === "running" || (acc[0] ?? false), ...acc], []);
	return (
		<div>
			<AgentCard node={node} now={now} selected={selected === node.id} onSelect={onSelect} />
			{kids.length > 0 ? (
				<div className="ml-4">
					{kids.map((child, index) => (
						<Edge key={child.id} last={index === kids.length - 1} running={child.status === "running"} laterRunning={runningFrom[index + 1] ?? false}>
							<Branch node={child} tree={tree} childMap={childMap} now={now} selected={selected} onSelect={onSelect} />
						</Edge>
					))}
				</div>
			) : null}
		</div>
	);
}

/**
 * The connector into one child: down the trunk to the child's first row,
 * across to its card, and (unless it is the last child) on down to the next.
 * A segment that leads to something running is dashed and flows.
 */
function Edge({
	last,
	running,
	laterRunning,
	children,
}: {
	readonly last: boolean;
	readonly running: boolean;
	readonly laterRunning: boolean;
	readonly children: React.ReactNode;
}): React.JSX.Element {
	const edge = (isRunning: boolean): string => (isRunning ? "agent-edge agent-edge-running" : "agent-edge");
	const bend = ELBOW_Y - ELBOW_RADIUS;
	return (
		<div className="relative pt-2" style={{ paddingLeft: EDGE_WIDTH + 4 }}>
			<svg aria-hidden className="pointer-events-none absolute left-0 top-0 h-full overflow-visible" width={EDGE_WIDTH}>
				<path
					className={edge(running)}
					d={`M${EDGE_X} 0 V${bend} Q${EDGE_X} ${ELBOW_Y} ${EDGE_X + ELBOW_RADIUS} ${ELBOW_Y} H${EDGE_WIDTH}`}
					fill="none"
				/>
				{last ? null : <line className={edge(laterRunning)} x1={EDGE_X} y1={bend} x2={EDGE_X} y2="100%" />}
			</svg>
			{children}
		</div>
	);
}
