import { Bot, MessageSquare, Sparkles, Timer } from "lucide-react";
import { useModelLabel } from "../state/agents.ts";
import type { AgentNode, AgentNodeKind, AgentStatus } from "./tree.ts";

/** One agent in the tree: what it is, what it runs on, how it is doing and what it is doing now. */

/** A finished node dims after this long, so what still works stands out. */
const DIM_AFTER_MS = 60_000;

export const KIND_ICON: Readonly<Record<AgentNodeKind, typeof Bot>> = {
	chat: MessageSquare,
	subagent: Bot,
	antigravity: Sparkles,
	automation: Timer,
};

export const KIND_COLOR: Readonly<Record<AgentNodeKind, string>> = {
	chat: "text-red",
	subagent: "text-text",
	antigravity: "text-violet",
	automation: "text-muted",
};

export const KIND_LABEL: Readonly<Record<AgentNodeKind, string>> = {
	chat: "Chat",
	subagent: "Subagent",
	antigravity: "Antigravity",
	automation: "Automation",
};

const STATUS_COLOR: Readonly<Record<AgentStatus, string>> = {
	running: "text-red",
	done: "text-[#73c991]",
	failed: "text-red",
	cancelled: "text-muted",
};

const DOT_COLOR: Readonly<Record<AgentStatus, string>> = {
	running: "bg-red pulse-dot",
	done: "bg-[#73c991]",
	failed: "bg-red",
	cancelled: "bg-muted",
};

/** 42s, 3m 05s, 1h 02m. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function elapsedOf(node: AgentNode, now: number): number {
	return (node.endedAt ?? now) - node.startedAt;
}

export function StatusChip({ status }: { readonly status: AgentStatus }): React.JSX.Element {
	return (
		<span className={`flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider ${STATUS_COLOR[status]}`}>
			<span className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_COLOR[status]}`} />
			{status}
		</span>
	);
}

export function AgentCard({
	node,
	now,
	selected,
	onSelect,
}: {
	readonly node: AgentNode;
	readonly now: number;
	readonly selected: boolean;
	readonly onSelect: (id: string) => void;
}): React.JSX.Element {
	const Icon = KIND_ICON[node.kind];
	const label = useModelLabel(node.model);
	const dim = node.endedAt !== null && now - node.endedAt > DIM_AFTER_MS;
	return (
		<button
			type="button"
			onClick={() => onSelect(node.id)}
			title={`${KIND_LABEL[node.kind]}: ${node.title} — click for its log`}
			className={`glass flex w-full flex-col gap-0.5 border px-3 py-2 text-left transition-[opacity,border-color] duration-300 ${
				selected ? "glow border-red/60" : "border-border hover:border-red/40"
			} ${dim && !selected ? "opacity-50 hover:opacity-90" : ""}`}
		>
			<span className="flex h-5 min-w-0 items-center gap-2">
				<Icon size={14} strokeWidth={1.8} className={`shrink-0 ${KIND_COLOR[node.kind]}`} />
				<span className="min-w-0 truncate font-condensed text-[13px] font-semibold uppercase tracking-wider">{node.title}</span>
				{label ? (
					<span
						className={`shrink-0 border px-1.5 font-mono text-[9.5px] leading-4 ${
							node.kind === "antigravity" ? "border-violet/50 text-violet" : "border-border text-muted"
						}`}
					>
						{label}
					</span>
				) : null}
				<span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
					<StatusChip status={node.status} />
					<span className="w-14 text-right font-mono text-[10.5px] tabular-nums text-muted">{formatElapsed(elapsedOf(node, now))}</span>
				</span>
			</span>
			{node.current ? <span className="truncate pl-[22px] font-mono text-[10.5px] text-muted">{node.current}</span> : null}
		</button>
	);
}
