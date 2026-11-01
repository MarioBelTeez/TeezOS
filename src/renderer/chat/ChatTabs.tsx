import { useMemo, useState } from "react";
import { History, Pause, Plus, X } from "lucide-react";
import type { Workspace } from "../../main/settings/store.ts";
import { useChats, type Chat } from "../state/chats.ts";
import { useUi } from "../state/ui.ts";
import { IconButton } from "../shell/IconButton.tsx";
import { revealPanel } from "../shell/dock-actions.ts";
import { useTerminals } from "../terminal/TerminalDock.tsx";
import { foldHistory } from "./reduce.ts";
import { AGENT_STYLE, agentName } from "./agent-options.ts";
import { orderedTabs } from "./tab-order.ts";
import { copyText, deletePastSession } from "./session-actions.ts";

/**
 * Every open chat of the workspace as a tab, so nothing hides behind the
 * history menu: switching agents opens a tab next to the one you left, and
 * both stay a click away. New tabs join at the end; drag to reorder.
 */

const TITLE_CHARS = 22;
/** How long the app's Claude process gets to let go of a session before the CLI takes it. */
const HANDOVER_DELAY_MS = 1500;
const TAB_DRAG = "application/x-teez-chat-tab";

type DropMark = { readonly chatId: string; readonly after: boolean };

/** Dropping on a tab's right half puts the dragged tab after it. */
function rightHalf(event: React.DragEvent): boolean {
	const rect = event.currentTarget.getBoundingClientRect();
	return event.clientX > rect.left + rect.width / 2;
}

function tabTitle(title: string): string {
	return title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS)}…` : title;
}

export function ChatTabs({
	workspace,
	activeChatId,
}: {
	readonly workspace: Workspace;
	readonly activeChatId: string | null;
}): React.JSX.Element {
	const chats = useChats((s) => s.chats);
	const order = useChats((s) => s.orderByWorkspace[workspace.id]);
	const activate = useChats((s) => s.activate);
	const [dropMark, setDropMark] = useState<DropMark | null>(null);
	const tabs = useMemo(
		() => orderedTabs(Object.values(chats).filter((c) => c.workspaceId === workspace.id), order ?? []),
		[chats, order, workspace.id],
	);
	const active = activeChatId ? chats[activeChatId] : undefined;

	const closeTab = (chat: Chat): void => {
		if (chat.running && !window.confirm(`“${chat.title}” is still working. Close it and stop the turn?`)) return;
		// Closing the tab in front of you shows its neighbour rather than a
		// fresh chat; the panel opens a new one only when none is left.
		const index = tabs.findIndex((t) => t.chatId === chat.chatId);
		const neighbour = chat.chatId === activeChatId ? (tabs[index + 1] ?? tabs[index - 1]) : undefined;
		useChats.getState().close(chat.chatId);
		if (neighbour) activate(workspace.id, neighbour.chatId);
	};

	/**
	 * Hand the chat in front of you to the phone: it closes here (one process
	 * per session) and the same session reopens in a terminal with Remote
	 * Control on, so the Claude app shows it with its whole history. Taking it
	 * back = close that terminal tab, then open it from Past sessions.
	 */
	const continueOnPhone = async (chat: Chat): Promise<void> => {
		if (chat.running) {
			useUi.getState().toast("Wait until Claude finishes this turn, then hand the chat over.", "error");
			return;
		}
		const sessionId = chat.sessionId;
		useChats.getState().close(chat.chatId);
		// Let the app's own Claude process release the session before the CLI resumes it.
		await new Promise((resolve) => setTimeout(resolve, HANDOVER_DELAY_MS));
		revealPanel("terminal");
		const started = await useTerminals.getState().open(workspace.id, "claude-resume-remote", undefined, sessionId);
		if (started) {
			useUi.getState().toast("Open the Claude app, then Code: the chat is there as TeezOS. To take it back, close that terminal tab and open it from Past sessions.");
			return;
		}
		// Nothing is running it now: bring the chat back here, history and all.
		const items = await window.teez.sessions.transcript(workspace.id, sessionId);
		await useChats.getState().openChat(workspace.id, { agent: "claude", resume: sessionId, title: chat.title, model: chat.model, history: foldHistory(items).cards });
		useUi.getState().toast("Could not hand the chat to your phone; it is back here.", "error");
	};

	/** Closes several tabs at once and leaves `keep` in front: one question if any is working. */
	const closeMany = (list: readonly Chat[], keep: Chat): void => {
		if (list.length === 0) return;
		const working = list.filter((c) => c.running).length;
		if (working > 0 && !window.confirm(`${working === 1 ? "One of these chats is" : `${working} of these chats are`} still working. Close them and stop the turn?`)) return;
		for (const c of list) useChats.getState().close(c.chatId);
		activate(workspace.id, keep.chatId);
	};

	const tabMenu = (event: React.MouseEvent, chat: Chat): void => {
		event.preventDefault();
		const others = tabs.filter((t) => t.chatId !== chat.chatId);
		const right = tabs.slice(tabs.findIndex((t) => t.chatId === chat.chatId) + 1);
		// Only a Claude chat that has run a turn has a session file behind it.
		const saved = chat.agent === "claude" && chat.sessionId !== "";
		useUi.getState().openMenu(event.clientX, event.clientY, [
			{ label: "Close", hint: "Middle-click", onSelect: () => closeTab(chat) },
			{ label: "Close others", disabled: others.length === 0, onSelect: () => closeMany(others, chat) },
			{ label: "Close tabs to the right", disabled: right.length === 0, onSelect: () => closeMany(right, chat) },
			{ separator: true },
			{
				label: "New chat like this",
				onSelect: () => void useChats.getState().openChat(workspace.id, { agent: chat.agent, model: chat.model, permission: chat.permission, effort: chat.effort }),
			},
			...(saved
				? [
						{ label: "Continue this chat on your phone", onSelect: () => void continueOnPhone(chat) },
						{ label: "Copy session ID", onSelect: () => copyText(chat.sessionId, "Session ID") },
						{ separator: true as const },
						{ label: "Delete session…", danger: true, onSelect: () => void deletePastSession(workspace.id, chat.sessionId, chat.title) },
					]
				: []),
		]);
	};

	const openHistory = (): void => {
		const rect = document.activeElement?.getBoundingClientRect();
		const newestFirst = [...tabs].reverse();
		const phone = active && active.agent === "claude" && active.sessionId ? active : null;
		useUi.getState().openMenu(rect?.left ?? 600, (rect?.bottom ?? 40) + 4, [
			...(phone ? [{ label: "Continue this chat on your phone", onSelect: () => void continueOnPhone(phone) }, { separator: true as const }] : []),
			...newestFirst.map((c) => ({
				label: `${c.chatId === activeChatId ? "● " : ""}${c.title}  ·  ${agentName(c.agent)}`,
				onSelect: () => activate(workspace.id, c.chatId),
			})),
			{ separator: true as const },
			{ label: "Past sessions…", onSelect: () => revealPanel("sessions") },
		]);
	};

	return (
		<header className="flex h-9 shrink-0 items-stretch border-b border-border bg-black/30">
			<div role="tablist" className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
				{tabs.map((chat) => (
					<ChatTab
						key={chat.chatId}
						chat={chat}
						selected={chat.chatId === activeChatId}
						dropMark={dropMark?.chatId === chat.chatId ? (dropMark.after ? "after" : "before") : null}
						onSelect={() => activate(workspace.id, chat.chatId)}
						onClose={() => closeTab(chat)}
						onContextMenu={(event) => tabMenu(event, chat)}
						onDragStart={(event) => {
							event.dataTransfer.setData(TAB_DRAG, chat.chatId);
							event.dataTransfer.effectAllowed = "move";
						}}
						onDragOver={(event) => {
							// Only our own tabs: files and the dock's panels pass through.
							if (!event.dataTransfer.types.includes(TAB_DRAG)) return;
							event.preventDefault();
							event.dataTransfer.dropEffect = "move";
							const after = rightHalf(event);
							if (dropMark?.chatId !== chat.chatId || dropMark.after !== after) setDropMark({ chatId: chat.chatId, after });
						}}
						onDragLeave={() => setDropMark((m) => (m?.chatId === chat.chatId ? null : m))}
						onDrop={(event) => {
							const moved = event.dataTransfer.getData(TAB_DRAG);
							setDropMark(null);
							if (!moved) return;
							event.preventDefault();
							useChats.getState().reorder(workspace.id, moved, chat.chatId, rightHalf(event));
						}}
						onDragEnd={() => setDropMark(null)}
					/>
				))}
			</div>
			<div className="flex shrink-0 items-center px-1">
				<IconButton label="Chats in this workspace" onClick={openHistory}>
					<History size={15} />
				</IconButton>
				<IconButton
					label="New chat"
					onClick={() =>
						void useChats
							.getState()
							.openChat(workspace.id, active ? { agent: active.agent, model: active.model, permission: active.permission, effort: active.effort } : {})
					}
				>
					<Plus size={16} />
				</IconButton>
			</div>
		</header>
	);
}

type DragHandlers = {
	readonly onDragStart: (event: React.DragEvent) => void;
	readonly onDragOver: (event: React.DragEvent) => void;
	readonly onDragLeave: () => void;
	readonly onDrop: (event: React.DragEvent) => void;
	readonly onDragEnd: () => void;
};

function ChatTab({
	chat,
	selected,
	dropMark,
	onSelect,
	onClose,
	onContextMenu,
	...drag
}: {
	readonly chat: Chat;
	readonly selected: boolean;
	/** Where a dragged tab would land, drawn as a red bar on that side. */
	readonly dropMark: "before" | "after" | null;
	readonly onSelect: () => void;
	readonly onClose: () => void;
	readonly onContextMenu: (event: React.MouseEvent) => void;
} & DragHandlers): React.JSX.Element {
	return (
		<div
			role="tab"
			tabIndex={0}
			draggable
			{...drag}
			aria-selected={selected}
			title={`${chat.title} · ${agentName(chat.agent)}`}
			onClick={onSelect}
			onContextMenu={onContextMenu}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onSelect();
				}
			}}
			// Middle-click closes, as in a browser; mousedown is stopped too so
			// the button does not start autoscroll.
			onMouseDown={(event) => {
				if (event.button === 1) event.preventDefault();
			}}
			onAuxClick={(event) => {
				if (event.button === 1) onClose();
			}}
			className={`group relative flex max-w-56 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-2.5 font-condensed text-[12px] font-semibold tracking-wide transition-colors ${
				selected ? "tab-active bg-surface-2 text-text" : "text-muted hover:bg-white/[0.03] hover:text-text"
			}`}
		>
			{dropMark ? (
				<span className={`pointer-events-none absolute inset-y-1 w-[2px] bg-red ${dropMark === "after" ? "-right-px" : "-left-px"}`} />
			) : null}
			{/* The agent's colour; it pulses while the chat is working. */}
			<span
				title={chat.running ? "Working" : undefined}
				className={`h-1.5 w-1.5 shrink-0 rounded-full ${AGENT_STYLE[chat.agent].dot} ${chat.running ? "pulse-dot" : ""} ${
					selected || chat.running ? AGENT_STYLE[chat.agent].glow : ""
				}`}
			/>
			<span className="truncate">{tabTitle(chat.title)}</span>
			{chat.pause ? <Pause size={10} aria-label="Waiting for the usage limit to reset" className="shrink-0 text-amber" /> : null}
			<button
				type="button"
				aria-label={`Close ${chat.title}`}
				title="Close (middle-click)"
				onClick={(event) => {
					event.stopPropagation();
					onClose();
				}}
				className={`-mr-1 flex h-4 w-4 shrink-0 items-center justify-center text-muted hover:text-red ${selected ? "" : "opacity-0 group-hover:opacity-100"}`}
			>
				<X size={11} />
			</button>
		</div>
	);
}
