import type { Chat } from "../state/chats.ts";
import { formatTokens as thousands } from "./usage-rails.ts";
import { ComposerPopover } from "./ComposerPopover.tsx";

/**
 * `/context` and `/cost`: how full the session's context is (from the last
 * turn's usage against the model's window), what it has cost and how many
 * turns it ran. "Compact now" sends `/compact`, which the CLI handles.
 */

export function ContextPopover({
	chat,
	anchor,
	onCompact,
	onClose,
}: {
	readonly chat: Chat;
	readonly anchor: React.RefObject<HTMLElement | null>;
	readonly onCompact: () => void;
	readonly onClose: () => void;
}): React.JSX.Element {
	const context = chat.context;
	const percent = context ? Math.min(100, Math.round((context.used / context.window) * 100)) : 0;
	// Amber from two thirds, red near the limit, where auto-compaction looms.
	const tone = percent >= 85 ? "bg-red" : percent >= 66 ? "bg-[#f59e0b]" : "bg-text/70";

	return (
		<ComposerPopover anchor={anchor} onClose={onClose} label="Context">
			<div className="space-y-2.5 px-3 py-2.5 font-mono text-[length:var(--chat-meta)] text-muted">
				<p className="font-condensed text-[11px] font-semibold uppercase tracking-wider">Context</p>
				{context ? (
					<div>
						<div className="h-2 w-full bg-bg ring-1 ring-border">
							<div className={`h-full ${tone}`} style={{ width: `${percent}%` }} />
						</div>
						<p className="mt-1 flex justify-between">
							<span className="text-text">
								{thousands(context.used)} / {thousands(context.window)} tokens
							</span>
							<span className="text-text">{percent}%</span>
						</p>
					</div>
				) : (
					<p>Nothing reported yet: the context shows after the first answer.</p>
				)}
				<p className="flex justify-between">
					<span>Cost so far</span>
					<span className="text-text">${chat.totalCostUsd.toFixed(4)}</span>
				</p>
				<p className="flex justify-between">
					<span>Turns</span>
					<span className="text-text">{chat.turns}</span>
				</p>
				<div className="flex justify-end pt-0.5">
					<button
						type="button"
						disabled={chat.running || !chat.sessionId}
						title={chat.running ? "Wait for the turn to finish" : "Summarize the conversation so far to free up context"}
						onClick={onCompact}
						className="cut-corner bg-surface px-2.5 py-1 font-condensed text-[11px] font-semibold uppercase tracking-wider text-muted ring-1 ring-border enabled:hover:text-text enabled:hover:ring-red/50 disabled:opacity-40"
					>
						Compact now
					</button>
				</div>
			</div>
		</ComposerPopover>
	);
}
