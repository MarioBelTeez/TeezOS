import { Bot, GitBranch, TerminalSquare } from "lucide-react";
import { agentName } from "../chat/agent-options.ts";
import { useActiveWorkspace } from "../state/settings.ts";
import { useTree } from "../state/tree.ts";
import { useChats } from "../state/chats.ts";
import { revealPanel, togglePanel, useDesk } from "./dock-actions.ts";

/** One line of facts along the bottom: branch, changes, the agent and what it costs. */
export function StatusBar(): React.JSX.Element {
	const workspace = useActiveWorkspace();
	const git = useTree((s) => (workspace ? s.trees[workspace.id]?.git : null));
	const chat = useChats((s) => {
		if (!workspace) return null;
		const id = s.activeByWorkspace[workspace.id];
		return id ? (s.chats[id] ?? null) : null;
	});
	const terminalOpen = useDesk((s) => s.visible.includes("terminal"));
	const changes = git ? Object.keys(git.files).length : 0;

	return (
		<footer className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-black/50 px-2 font-mono text-[10.5px] text-muted">
			<div className="flex min-w-0 items-center gap-3">
				{git ? (
					<button
						type="button"
						onClick={() => revealPanel("git")}
						className="flex items-center gap-1 hover:text-text"
						title="Source control"
					>
						<GitBranch size={11} />
						{git.branch || "no branch"}
						{git.ahead ? <span className="text-[#73c991]">↑{git.ahead}</span> : null}
						{git.behind ? <span className="text-[#f5a524]">↓{git.behind}</span> : null}
						{changes ? <span className="text-[#e2c08d]">● {changes}</span> : null}
					</button>
				) : null}
				{workspace ? <span className="truncate opacity-70">{workspace.path}</span> : null}
			</div>
			<div className="flex shrink-0 items-center gap-3">
				{chat ? (
					<span className="flex items-center gap-1" title="Agent in this workspace">
						{chat.running ? <span className="pulse-dot mx-0.5 h-1.5 w-1.5 rounded-full bg-red-hot shadow-[0_0_8px_var(--color-glow)]" /> : <Bot size={11} />}
						{agentName(chat.agent)}
						{chat.sessionModel || chat.model ? ` · ${chat.sessionModel || chat.model}` : ""}
						{chat.totalCostUsd > 0 ? ` · $${chat.totalCostUsd.toFixed(3)}` : ""}
					</span>
				) : null}
				<button
					type="button"
					onClick={() => togglePanel("terminal")}
					className={`flex items-center gap-1 hover:text-text ${terminalOpen ? "text-text" : ""}`}
					title="Toggle terminal (Ctrl+`)"
				>
					<TerminalSquare size={11} />
					Terminal
				</button>
			</div>
		</footer>
	);
}
