import type { ReactNode } from "react";
import type { ChatSummary } from "../chat-stream.ts";
import { ago } from "../format.ts";
import { Empty } from "../components/ui.tsx";

/** Past phone chats, newest first, and a New button. Slides over the chat from the left. */
export function Drawer({ chats, currentId, onPick, onNew, onClose }: { chats: readonly ChatSummary[]; currentId: string | null; onPick: (id: string) => void; onNew: () => void; onClose: () => void }): ReactNode {
	return (
		<div className="fixed inset-0 z-40 flex bg-black/60" onClick={onClose}>
			<nav aria-label="Chats" className="safe-top safe-bottom glass flex w-[82%] max-w-sm flex-col border-r border-red/50" onClick={(event) => event.stopPropagation()}>
				<div className="safe-x flex items-center justify-between pb-2">
					<h2 className="font-display glow-text text-[26px] tracking-wider">Chats</h2>
					<button type="button" onClick={onNew} className="btn-hot h-11 px-4 font-display text-[20px] tracking-wider">
						New
					</button>
				</div>
				<ul className="scroll-y flex-1">
					{chats.length === 0 ? <Empty>No chats yet.</Empty> : null}
					{chats.map((chat) => (
						<li key={chat.id}>
							<button
								type="button"
								onClick={() => onPick(chat.id)}
								className={`safe-x flex min-h-14 w-full flex-col items-start justify-center border-b border-border py-2 text-left ${chat.id === currentId ? "tab-active" : ""}`}
							>
								<span className="w-full truncate text-[17px]">{chat.title}</span>
								<span className="font-mono text-[12px] text-muted">
									{chat.engine === "claude" ? "Claude" : "Antigravity"} · {ago(chat.updatedAt)}
								</span>
							</button>
						</li>
					))}
				</ul>
			</nav>
		</div>
	);
}
