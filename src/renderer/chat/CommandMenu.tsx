import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { SlashCommandInfo } from "../../main/agents/registry.ts";
import type { Chat } from "../state/chats.ts";
import { ComposerPopover } from "./ComposerPopover.tsx";
import { filterCommands, mergeCommands, type CommandItem } from "./commands.ts";

/**
 * The `/` menu over the composer. Typing `/` at the start of the box opens it
 * and the box's text filters it (the box keeps focus and hands it the arrow
 * keys, Enter, Tab and Esc); the `/` button opens it with a search field of
 * its own.
 */

/** The last full list per workspace, so a chat that has not started yet still offers the CLI's. */
const known = new Map<string, readonly SlashCommandInfo[]>();

export type CommandMenuHandle = {
	/** A key typed in the composer; true when the menu used it. */
	readonly key: (event: React.KeyboardEvent) => boolean;
};

export function CommandMenu({
	chat,
	query,
	anchor,
	handleRef,
	onPick,
	onClose,
}: {
	readonly chat: Chat;
	/** The composer's text after `/`, or null for the menu's own search field. */
	readonly query: string | null;
	readonly anchor: React.RefObject<HTMLElement | null>;
	readonly handleRef: React.Ref<CommandMenuHandle>;
	readonly onPick: (item: CommandItem) => void;
	readonly onClose: () => void;
}): React.JSX.Element {
	const [cli, setCli] = useState<readonly SlashCommandInfo[]>(() => known.get(chat.workspaceId) ?? []);
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState(0);
	const list = useRef<HTMLDivElement>(null);
	const { chatId, agent, workspaceId, slashCommands } = chat;

	useEffect(() => {
		if (agent !== "claude") return;
		let live = true;
		window.teez.chat.commands(chatId).then(
			(commands) => {
				if (!live || commands.length === 0) return;
				known.set(workspaceId, commands);
				setCli(commands);
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [chatId, agent, workspaceId]);

	// Before the session can be asked, the names init reported still help.
	const source = useMemo<readonly SlashCommandInfo[]>(
		() => (cli.length > 0 ? cli : slashCommands.map((name) => ({ name, description: "", argumentHint: "" }))),
		[cli, slashCommands],
	);
	const items = useMemo(() => mergeCommands(source, agent), [source, agent]);
	const text = query ?? search;
	const shown = useMemo(() => filterCommands(items, text), [items, text]);
	const current = shown[Math.min(selected, shown.length - 1)];

	useEffect(() => setSelected(0), [text]);
	useEffect(() => {
		list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [selected, shown]);

	const key = (event: React.KeyboardEvent): boolean => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (shown.length > 0) setSelected((s) => (Math.min(s, shown.length - 1) + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
			return true;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return true;
		}
		if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
			if (!current) return false;
			// "/compact" typed out in full: Enter sends it, as it reads.
			if (event.key === "Enter" && current.action === "insert" && query === current.name) return false;
			event.preventDefault();
			onPick(current);
			return true;
		}
		return false;
	};
	useImperativeHandle(handleRef, () => ({ key }));

	return (
		<ComposerPopover anchor={anchor} onClose={onClose} label="Commands">
			{query === null ? (
				<input
					autoFocus
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					onKeyDown={(event) => {
						key(event);
					}}
					placeholder="Search commands…"
					className="w-full border-b border-border bg-transparent px-3 py-2 font-mono text-[length:var(--chat-meta)] text-text outline-none placeholder:text-muted/70"
				/>
			) : null}
			<div ref={list} role="listbox" className="max-h-72 overflow-y-auto py-1">
				{shown.length === 0 ? (
					<p className="px-3 py-1.5 font-mono text-[length:var(--chat-meta)] text-muted">No command matches.</p>
				) : (
					shown.map((item, index) => {
						const active = item === current;
						return (
							<button
								key={item.name}
								type="button"
								role="option"
								aria-selected={active}
								data-selected={active}
								// Keeps focus in the composer while picking.
								onMouseDown={(event) => event.preventDefault()}
								onMouseEnter={() => setSelected(index)}
								onClick={() => onPick(item)}
								className={`flex w-full items-baseline gap-2 px-3 py-1 text-left ${active ? "bg-red/20" : ""}`}
							>
								<span className={`shrink-0 font-mono text-[length:var(--chat-tool)] ${item.action === "insert" ? "text-text" : "text-red"}`}>/{item.name}</span>
								{item.argumentHint ? <span className="shrink-0 font-mono text-[length:var(--chat-meta)] text-muted/70">{item.argumentHint}</span> : null}
								<span className="min-w-0 flex-1 truncate text-[length:var(--chat-meta)] text-muted">{item.description}</span>
							</button>
						);
					})
				)}
			</div>
		</ComposerPopover>
	);
}
