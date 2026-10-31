import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Workspace } from "../../main/settings/store.ts";
import { useChats, type Chat } from "../state/chats.ts";
import { useUi } from "../state/ui.ts";
import { MAX_IMAGES } from "../../shared/images.ts";
import { IMAGE_TYPES, prepareImage, type PastedImage } from "./pasted-images.ts";
import { agentName } from "./agent-options.ts";
import { ComposerBar } from "./ComposerBar.tsx";
import { UsageRails } from "./UsageRails.tsx";
import { combineDraft } from "./draft.ts";
import { revealPanel } from "../shell/dock-actions.ts";
import { CommandMenu, type CommandMenuHandle } from "./CommandMenu.tsx";
import { BtwPopover } from "./BtwPopover.tsx";
import { ContextPopover } from "./ContextPopover.tsx";
import { teezCommand, type CommandAction, type CommandItem } from "./commands.ts";

/**
 * Where a message is written: text, `@path` mentions handed over from the
 * tree or the editor, screenshots pasted or dropped in, and the bar with the
 * model, the mode and Send underneath.
 */

/** A `/` at the very start with no space yet: the command menu filters on what follows. */
const SLASH = /^\/(\S*)$/;

export type QuickPrompt = { readonly label: string; readonly text: string };

export function Composer({
	workspace,
	chat,
	quickPrompts,
}: {
	readonly workspace: Workspace;
	readonly chat: Chat | null;
	readonly quickPrompts: readonly QuickPrompt[];
}): React.JSX.Element {
	const [draft, setDraft] = useState("");
	const [images, setImages] = useState<readonly PastedImage[]>([]);
	const [imageHint, setImageHint] = useState<string | null>(null);
	// Images attached or still being prepared, and which message they are for:
	// a send or a chat switch moves on, and a late one is dropped, not carried over.
	const slots = useRef(0);
	const generation = useRef(0);
	const area = useRef<HTMLTextAreaElement>(null);
	const box = useRef<HTMLDivElement>(null);
	const footer = useRef<HTMLElement>(null);
	const menuHandle = useRef<CommandMenuHandle>(null);
	const insert = useUi((s) => s.composerInsert);
	const menu = useUi((s) => s.composerMenu);
	const setMenu = useUi((s) => s.setComposerMenu);
	// Typed: the box's text after "/" is the menu's filter. Button: it has a field of its own.
	const [menuSource, setMenuSource] = useState<"typed" | "button">("typed");
	// "/btw <question>" hands its question to the popover, which asks at once.
	const [btwSeed, setBtwSeed] = useState("");
	// A new "/btw <question>" while the popover is open starts it afresh.
	const [btwRound, setBtwRound] = useState(0);
	const closeMenu = useCallback(() => setMenu(null), [setMenu]);
	const send = useChats((s) => s.send);
	const stop = useChats((s) => s.stop);

	// Text handed over from the tree or the editor ("Ask the agent about this"),
	// or the hand-over from a chat with the other agent.
	useEffect(() => {
		if (!insert) return;
		setDraft((previous) => combineDraft(previous, insert.text, insert.mode));
		// Taken once: a composer mounting later must not paste it again.
		useUi.getState().consumeComposerInsert();
		area.current?.focus();
	}, [insert]);

	// Grow with the text up to a third of the panel.
	useEffect(() => {
		const element = area.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
	}, [draft]);

	const clearImages = (): void => {
		generation.current += 1;
		slots.current = 0;
		setImages([]);
		setImageHint(null);
	};

	// Attachments, and any open menu, belong to the chat they were opened in.
	const chatId = chat?.chatId;
	useEffect(() => {
		clearImages();
		setMenu(null);
	}, [chatId, setMenu]);
	// Chat closed with a popover open: the menu goes with it, or the browser page would stay hidden.
	useEffect(() => () => setMenu(null), [setMenu]);

	/** TeezAI's own commands, from the menu or typed out in full. */
	const run = (action: Exclude<CommandAction, "insert">, argument: string): void => {
		if (!chat) return;
		switch (action) {
			case "btw":
				setBtwSeed(argument);
				if (argument) setBtwRound((n) => n + 1);
				setMenu("btw");
				return;
			case "clear":
				setMenu(null);
				void useChats.getState().openChat(workspace.id, { agent: chat.agent, model: chat.model, permission: chat.permission, effort: chat.effort });
				return;
			case "model":
			case "mode":
			case "effort":
				// The picker opens itself (see ComposerBar).
				setMenu(action);
				return;
			case "context":
			case "cost":
				setMenu("context");
				return;
			case "resume":
				setMenu(null);
				revealPanel("sessions");
				return;
		}
	};

	const pickCommand = (item: CommandItem): void => {
		if (item.action === "insert") {
			// A CLI command must lead the message for the CLI to expand it.
			setDraft((previous) => (menuSource === "typed" || !previous.trim() ? `/${item.name} ` : `/${item.name} ${previous}`));
			setMenu(null);
			area.current?.focus();
			return;
		}
		if (menuSource === "typed") setDraft("");
		run(item.action, "");
		if (item.action !== "btw") area.current?.focus();
	};

	const openCommands = (): void => {
		if (menu === "commands") {
			setMenu(null);
			return;
		}
		// An empty box takes the "/" itself, so typing goes on filtering.
		if (!draft) {
			setDraft("/");
			setMenuSource("typed");
			area.current?.focus();
		} else {
			setMenuSource("button");
		}
		setMenu("commands");
	};

	const openBtw = (): void => {
		setBtwSeed("");
		setMenu(menu === "btw" ? null : "btw");
	};

	const onDraftChange = (next: string): void => {
		const wasSlash = SLASH.test(draft);
		const isSlash = SLASH.test(next);
		if (isSlash && !wasSlash && menu === null) {
			setMenuSource("typed");
			setMenu("commands");
		} else if (!isSlash && menu === "commands" && menuSource === "typed") {
			setMenu(null);
		}
		setDraft(next);
	};

	const submit = (): void => {
		if (!chat || (!draft.trim() && images.length === 0)) return;
		const own = images.length === 0 ? teezCommand(draft, chat.agent) : null;
		if (own) {
			setDraft("");
			run(own.action, own.argument);
			return;
		}
		send(chat.chatId, draft, images);
		setDraft("");
		clearImages();
		if (menu === "commands") setMenu(null);
	};

	const slashQuery = menuSource === "typed" ? (SLASH.exec(draft)?.[1] ?? "") : null;

	/** Screenshots pasted or dropped in. Claude sees them; Antigravity's CLI takes text only. */
	const addImages = (files: readonly File[]): boolean => {
		const pictures = files.filter((file) => IMAGE_TYPES.has(file.type) && file.size > 0);
		if (pictures.length === 0 || !chat) return false;
		if (chat.agent !== "claude") {
			setImageHint("Antigravity's CLI takes text only — switch this chat to Claude to send images.");
			return true;
		}
		const room = Math.max(0, MAX_IMAGES - slots.current);
		const taken = pictures.slice(0, room);
		slots.current += taken.length;
		setImageHint(taken.length < pictures.length ? `Up to ${MAX_IMAGES} images per message.` : null);
		const forMessage = generation.current;
		for (const file of taken) {
			prepareImage(file).then(
				(image) => {
					if (generation.current === forMessage) setImages((previous) => [...previous, image]);
				},
				() => {
					if (generation.current !== forMessage) return;
					slots.current -= 1;
					setImageHint(`${file.name || "That image"} could not be read.`);
				},
			);
		}
		return true;
	};

	return (
		<footer ref={footer} className="relative shrink-0 border-t border-border bg-black/20 p-3">
			{/* Plan limits on the left, this chat's context on the right, when there is room for them. */}
			<UsageRails
				row={footer}
				composer={box}
				chat={chat}
				onCompact={() => {
					if (chat) send(chat.chatId, "/compact");
				}}
			/>
			{/* On a wide screen the composer keeps the conversation's width rather than running edge to edge. */}
			<div ref={box} className="relative mx-auto w-full max-w-[var(--chat-column)]">
			{chat && menu === "commands" ? (
				<CommandMenu chat={chat} query={slashQuery} anchor={box} handleRef={menuHandle} onPick={pickCommand} onClose={closeMenu} />
			) : null}
			{chat && menu === "btw" ? <BtwPopover key={`${chat.chatId}-${btwRound}`} chat={chat} anchor={box} initialQuestion={btwSeed} onClose={closeMenu} /> : null}
			{chat && menu === "context" ? (
				<ContextPopover
					chat={chat}
					anchor={box}
					onClose={closeMenu}
					onCompact={() => {
						setMenu(null);
						send(chat.chatId, "/compact");
					}}
				/>
			) : null}
			{quickPrompts.length > 0 && chat && !chat.running ? (
				<div className="mb-2 flex flex-wrap gap-1.5">
					{quickPrompts.map((prompt) => (
						<button
							key={prompt.label}
							type="button"
							title={prompt.text}
							onClick={() => send(chat.chatId, prompt.text)}
							className="cut-corner bg-surface px-2.5 py-0.5 font-condensed text-[11px] font-semibold uppercase tracking-wider text-muted ring-1 ring-border hover:text-text hover:ring-red/50"
						>
							{prompt.label}
						</button>
					))}
				</div>
			) : null}
			{images.length > 0 || imageHint ? (
				<div className="mb-2 flex flex-wrap items-center gap-2">
					{images.map((image, index) => (
						<div key={index} className="group relative">
							<img src={image.thumb} alt="" className="h-14 w-14 object-cover ring-1 ring-border" />
							<button
								type="button"
								title="Remove"
								onClick={() => {
									slots.current -= 1;
									setImages((previous) => previous.filter((_, i) => i !== index));
								}}
								className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center bg-red text-white opacity-0 group-hover:opacity-100"
							>
								<X size={10} />
							</button>
						</div>
					))}
					{imageHint ? <span className="text-[length:var(--chat-meta)] text-muted">{imageHint}</span> : null}
				</div>
			) : null}
			<div
				className="flex flex-col bg-surface-2/80 shadow-[0_0_28px_rgb(232_0_45/0.14)] ring-1 ring-red/45 transition-shadow focus-within:glow"
				onDragOver={(event) => {
					if (event.dataTransfer.types.includes("Files")) event.preventDefault();
				}}
				onDrop={(event) => {
					if (addImages([...event.dataTransfer.files])) event.preventDefault();
				}}
			>
				<textarea
					ref={area}
					value={draft}
					onChange={(event) => onDraftChange(event.target.value)}
					onPaste={(event) => {
						// Word and Excel put a picture of the selection next to its text: text wins.
						if (event.clipboardData.types.includes("text/plain")) return;
						if (addImages([...event.clipboardData.files])) event.preventDefault();
					}}
					onKeyDown={(event) => {
						if (menu === "commands" && menuSource === "typed" && menuHandle.current?.key(event)) return;
						// Esc closes an open menu first; only then does it stop the turn.
						if (event.key === "Escape" && menu !== null) {
							setMenu(null);
							return;
						}
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						}
						if (event.key === "Escape" && chat?.running) stop(chat.chatId);
					}}
					rows={1}
					placeholder={chat ? `Message ${agentName(chat.agent)} in ${workspace.name}…` : "Starting…"}
					className="max-h-64 min-h-[40px] w-full resize-none bg-transparent px-3 py-2.5 text-[length:var(--chat-text)] text-text outline-none placeholder:text-muted/70"
				/>
				<ComposerBar
					workspace={workspace}
					chat={chat}
					canSend={Boolean(chat) && (draft.trim() !== "" || images.length > 0)}
					onSend={submit}
					onBtw={openBtw}
					onCommands={openCommands}
				/>
			</div>
			</div>
		</footer>
	);
}
