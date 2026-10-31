import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { IconButton } from "../shell/IconButton.tsx";
import { KIND_COLOR, KIND_ICON, KIND_LABEL, StatusChip, elapsedOf, formatElapsed } from "./AgentCard.tsx";
import { useModelLabel } from "../state/agents.ts";
import type { AgentNode } from "./tree.ts";

/** A node's log at the right of the Agents view: every step it took, with the time it took it. */

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function AgentDrawer({ node, now, onClose }: { readonly node: AgentNode; readonly now: number; readonly onClose: () => void }): React.JSX.Element {
	const Icon = KIND_ICON[node.kind];
	const list = useRef<HTMLOListElement>(null);
	const label = useModelLabel(node.model);

	// The newest step is at the bottom; follow it unless the reader scrolled up.
	const stepCount = node.steps.length;
	const lastAt = node.steps.at(-1)?.at;
	const shownId = useRef<string | null>(null);
	useEffect(() => {
		const element = list.current;
		if (!element) return;
		const opened = shownId.current !== node.id;
		shownId.current = node.id;
		const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
		if (opened || nearBottom) element.scrollTop = element.scrollHeight;
	}, [stepCount, lastAt, node.id]);

	return (
		<aside
			aria-label={`${KIND_LABEL[node.kind]} log`}
			className="glass absolute inset-y-0 right-0 z-10 flex w-[min(420px,90%)] flex-col border-l border-border shadow-[-12px_0_32px_rgb(0_0_0/0.5)]"
		>
			<header className="flex items-start gap-2 border-b border-border px-4 py-3">
				<Icon size={16} strokeWidth={1.8} className={`mt-1 shrink-0 ${KIND_COLOR[node.kind]}`} />
				<div className="min-w-0 flex-1">
					<h2 className="break-words font-display text-2xl leading-tight tracking-wide">{node.title}</h2>
					<p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-muted">
						<span>{KIND_LABEL[node.kind]}</span>
						{label ? <span>{label}</span> : null}
						<StatusChip status={node.status} />
						<span>
							{clock(node.startedAt)} · {formatElapsed(elapsedOf(node, now))}
						</span>
					</p>
				</div>
				<IconButton label="Close the log" onClick={onClose}>
					<X size={15} />
				</IconButton>
			</header>
			{node.steps.length === 0 ? (
				<p className="px-4 py-6 font-mono text-[11px] text-muted">
					{node.kind === "automation" ? "Open Automations for this run's full log." : "No steps yet."}
				</p>
			) : (
				<ol ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
					{node.steps.map((step) => (
						<li key={step.seq} className="flex gap-3 py-1 font-mono text-[11px] leading-snug">
							<span className="shrink-0 tabular-nums text-muted">{clock(step.at)}</span>
							<span className={`min-w-0 break-words ${step.text.startsWith("says: ") ? "text-muted italic" : "text-text"}`}>{step.text}</span>
						</li>
					))}
				</ol>
			)}
		</aside>
	);
}
