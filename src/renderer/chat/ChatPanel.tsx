import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Pause } from "lucide-react";
import type { Workspace } from "../../main/settings/store.ts";
import { useChats, type Chat } from "../state/chats.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { useEditor } from "../state/editor.ts";
import type { PauseView } from "./reduce.ts";
import { CardView, type CardActions } from "./Cards.tsx";
import { useTerminals } from "../terminal/TerminalDock.tsx";
import { revealPanel } from "../shell/dock-actions.ts";
import { AGENT_STYLE, agentName } from "./agent-options.ts";
import { SCROLL_KEYS, isReaderScroll, stickAfterChatChange, stickAfterScroll } from "./scroll.ts";
import { ChatTabs } from "./ChatTabs.tsx";
import { Composer, type QuickPrompt } from "./Composer.tsx";
import { textSizeForKey } from "./text-size.ts";

/**
 * The chats of the active workspace: a tab per open chat, the conversation,
 * and the composer with the model and mode under the text box. The text
 * scale is one attribute on the root (see `--chat-*` in index.css).
 */

export function ChatPanel({
	workspace,
	quickPrompts = [],
}: {
	readonly workspace: Workspace;
	readonly quickPrompts?: readonly QuickPrompt[];
}): React.JSX.Element {
	const chatId = useChats((s) => s.activeByWorkspace[workspace.id]);
	const chat = useChats((s) => (chatId ? s.chats[chatId] : undefined));
	const ensureChat = useChats((s) => s.ensureChat);
	const textSize = useSettings((s) => s.settings?.modules.chat.textSize ?? "m");

	useEffect(() => {
		void ensureChat(workspace.id);
	}, [workspace.id, chatId, ensureChat]);

	// Ctrl+= / Ctrl+- / Ctrl+0 resize the chat's text while focus is in the
	// panel; the panel takes focus on click (tabIndex -1) so reading counts.
	const onKeyDown = (event: React.KeyboardEvent): void => {
		if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
		const next = textSizeForKey(textSize, event.key);
		if (next === null) return;
		// Also keeps Electron's own zoom from scaling the whole window.
		event.preventDefault();
		if (next !== textSize) useSettings.getState().setModules({ chat: { textSize: next } });
	};

	return (
		<section data-chat-size={textSize} tabIndex={-1} onKeyDown={onKeyDown} className="flex h-full min-w-0 flex-col outline-none">
			<ChatTabs workspace={workspace} activeChatId={chatId ?? null} />
			{chat ? <ChatBody chat={chat} workspace={workspace} /> : <div className="flex-1" />}
			{chat?.pause ? <PauseBanner chatId={chat.chatId} pause={chat.pause} /> : null}
			<Composer workspace={workspace} chat={chat ?? null} quickPrompts={quickPrompts} />
		</section>
	);
}

/** The chat is stopped by the plan limit and will carry on by itself; Cancel keeps it stopped. */
function PauseBanner({ chatId, pause }: { readonly chatId: string; readonly pause: PauseView }): React.JSX.Element {
	const cancelPause = useChats((s) => s.cancelPause);
	const at = new Date(pause.resumesAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return (
		<div role="status" className="flex shrink-0 items-center justify-center gap-3 border-t border-amber/40 bg-amber/10 px-4 py-1.5 font-mono text-[length:var(--chat-meta)] text-amber">
			<Pause size={12} />
			<span>
				Paused by the usage limit — {pause.estimated ? "trying again around" : "resumes at"} {at}
			</span>
			<button type="button" onClick={() => cancelPause(chatId)} className="font-condensed font-semibold uppercase tracking-wider text-text underline-offset-2 hover:underline">
				Cancel
			</button>
		</div>
	);
}

function ChatBody({ chat, workspace }: { readonly chat: Chat; readonly workspace: Workspace }): React.JSX.Element {
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const shownChat = useRef<string | null>(null);
	/** When the reader last used the wheel, touch, keys or the pointer on the conversation. */
	const readerInputAt = useRef<number | null>(null);
	const markReaderInput = (): void => {
		readerInputAt.current = Date.now();
	};
	/** A pointer held down on the conversation (a scrollbar drag can last any time). */
	const pointerHeld = useRef(false);
	/** Where the last scroll event left the conversation, to tell up from down. */
	const lastTop = useRef(0);
	const column = useRef<HTMLDivElement>(null);

	// Scroll keys reach Chromium's last-clicked scroller even when focus is on
	// the page, not this div: listen on the window. Typing in a text box is not
	// scrolling. A held pointer ends wherever the pointer is released.
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			const target = event.target as HTMLElement | null;
			if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
			if (SCROLL_KEYS.has(event.key)) markReaderInput();
		};
		const release = (): void => {
			pointerHeld.current = false;
		};
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("pointerup", release, true);
		window.addEventListener("pointercancel", release, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("pointerup", release, true);
			window.removeEventListener("pointercancel", release, true);
		};
	}, []);
	const approve = useChats((s) => s.approve);

	// Follow new output only while the reader is at the bottom; scrolling up
	// to read something must not be yanked back down by the next delta.
	// A chat just opened or switched to starts at its newest message: the
	// previous chat's scroll position says nothing about this one. Layout
	// effect, so the first paint is already at the bottom.
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		stick.current = stickAfterChatChange(shownChat.current, chat.chatId, stick.current);
		shownChat.current = chat.chatId;
		if (stick.current) element.scrollTop = element.scrollHeight;
	}, [chat.cards, chat.chatId]);

	// Images and long blocks settle after the cards render, and the panel
	// itself can be shown (it had no height while hidden) or resized: keep
	// following the bottom through all of it.
	useEffect(() => {
		const content = column.current;
		const element = scroller.current;
		if (!content || !element) return;
		const observer = new ResizeObserver(() => {
			if (stick.current) element.scrollTop = element.scrollHeight;
		});
		observer.observe(content);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const actions = useMemo<CardActions>(
		() => ({
			onApprove: (requestId, decision, updatedInput) => approve(chat.chatId, requestId, decision, updatedInput),
			onSend: (text) => useChats.getState().send(chat.chatId, text),
			onOpenFile: (path) => {
				const normal = path.replace(/\\/g, "/");
				const root = workspace.path.replace(/\\/g, "/").toLowerCase();
				const relative = normal.toLowerCase().startsWith(`${root}/`) ? normal.slice(root.length + 1) : normal;
				void useEditor.getState().open(workspace.id, relative);
				revealPanel("editor");
			},
			onRetry: () => {
				const cards = useChats.getState().chats[chat.chatId]?.cards ?? [];
				const last = [...cards].reverse().find((c) => c.kind === "user");
				if (last && last.kind === "user") useChats.getState().send(chat.chatId, last.text);
			},
			onLogin: () => {
				void (async () => {
					useUi.getState().toast("Opening browser sign-in…", "info");
					const res = await window.teez.agents.login(chat.agent);
					if (res.ok) {
						useUi.getState().toast("Signed in! Send your message again.", "success");
						return;
					}
					useUi.getState().toast(res.error ?? "Browser sign-in failed — opening terminal fallback.", "error");
					revealPanel("terminal");
					void useTerminals.getState().open(workspace.id, chat.agent === "agy" ? "agy" : chat.agent === "codex" ? "codex-login" : "claude-login");
				})();
			},
		}),
		[approve, chat.chatId, chat.agent, workspace.id, workspace.path],
	);

	return (
		<div
			ref={scroller}
			onWheel={markReaderInput}
			onTouchMove={markReaderInput}
			onPointerDown={() => {
				pointerHeld.current = true;
				markReaderInput();
			}}
			onScroll={(event) => {
				const el = event.currentTarget;
				const movedUp = el.scrollTop < lastTop.current - 1;
				lastTop.current = el.scrollTop;
				stick.current = stickAfterScroll({
					stick: stick.current,
					atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 40,
					byReader: pointerHeld.current || isReaderScroll(readerInputAt.current, Date.now()),
					movedUp,
				});
			}}
			// No scroll anchoring: Chromium's own scroll adjustments are what left chats mid-way.
			style={{ overflowAnchor: "none" }}
			className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
		>
			<div ref={column} className="mx-auto w-full max-w-[var(--chat-column)] space-y-3">
				{chat.cards.length === 0 ? (
					<div className="pt-12 text-center">
						<p
							className={`bg-linear-to-b from-text bg-clip-text font-display text-5xl tracking-wider text-transparent ${
								AGENT_STYLE[chat.agent].heading
							}`}
						>
							{AGENT_STYLE[chat.agent].title}
						</p>
						<p className="mt-2 font-mono text-[length:var(--chat-meta)] text-muted">
							Runs in <span className="text-text">{workspace.name}</span>
							{AGENT_STYLE[chat.agent].tagline}
						</p>
						<p className="mt-1 font-mono text-[length:var(--chat-meta)] text-muted/70">Type @ to mention a file · Enter to send</p>
					</div>
				) : null}
				{chat.cards.map((card) => (
					<CardView key={card.id} card={card} agentName={agentName(chat.agent)} actions={actions} streaming={card.id === chat.streamingId} />
				))}
				{chat.running && !chat.streamingId ? (
					<p className="flex items-center gap-2 font-mono text-[length:var(--chat-meta)] text-muted">
						<span className="pulse-dot h-1.5 w-1.5 rounded-full bg-red-hot shadow-[0_0_8px_var(--color-glow)]" /> working…
					</p>
				) : null}
			</div>
		</div>
	);
}
