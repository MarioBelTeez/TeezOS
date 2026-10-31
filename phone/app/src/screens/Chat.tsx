import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { addUserMessage } from "../../../../src/renderer/chat/reduce.ts";
import { postJson, type ApiResult } from "../api.ts";
import type { ChatSummary, Engine } from "../chat-stream.ts";
import { Composer, DEFAULT_EFFORT } from "../chat/Composer.tsx";
import { Drawer } from "../chat/Drawer.tsx";
import { Messages } from "../chat/Messages.tsx";
import { useChat } from "../chat/useChat.ts";
import { useResource } from "../components/hooks.ts";
import { Empty, ErrorLine, IconButton, ScreenHeader, Sheet } from "../components/ui.tsx";
import { browserStorage, createDraft } from "../draft.ts";

/**
 * Chat first: the app opens here, on the newest chat, with the composer
 * focused. The draft survives a failed send and a closed app; a new chat is
 * only made on the server when its first message goes out.
 */

type Props = { active: boolean; routeId: string | null; onRoute: (id: string | null) => void };
type Failure = { text: string; offline: boolean };

const draft = createDraft(browserStorage(), "composer");
const failureOf = (result: ApiResult<unknown>): Failure | null => (result.ok ? null : { text: result.error, offline: result.offline });

export function Chat({ active, routeId, onRoute }: Props): ReactNode {
	const chats = useResource<ChatSummary[]>("/api/chats", active);
	const [chatId, setChatId] = useState<string | null>(routeId);
	const [picked, setPicked] = useState(routeId !== null);
	const { view, meta, error, update } = useChat(chatId);
	const [text, setText] = useState(draft.text());
	const [sending, setSending] = useState(false);
	const [failure, setFailure] = useState<Failure | null>(null);
	const [drawer, setDrawer] = useState(false);
	const [actionsFor, setActionsFor] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const [engine, setEngine] = useState<Engine>("agy");
	const [effort, setEffort] = useState(DEFAULT_EFFORT.agy);
	const [claudeBlocked, setClaudeBlocked] = useState<string | null>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const locked = view.cards.length > 0;

	const select = (id: string | null): void => {
		setPicked(true);
		setChatId(id);
		onRoute(id);
		setDrawer(false);
	};

	// A notification opened a chat.
	useEffect(() => {
		if (routeId !== null && routeId !== chatId) select(routeId);
	}, [routeId]);

	// Opens on the newest chat, once.
	useEffect(() => {
		const newest = chats.data?.[0];
		if (!picked && newest) {
			setPicked(true);
			setChatId(newest.id);
		}
	}, [chats.data, picked]);

	// A chat with messages shows its own engine and effort.
	useEffect(() => {
		if (meta && locked) {
			setEngine(meta.engine);
			setEffort(meta.effort);
		}
	}, [meta, locked]);

	useEffect(() => {
		if (active && !drawer) input.current?.focus();
	}, [active, drawer, chatId]);

	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(null), 2500);
		return () => clearTimeout(timer);
	}, [toast]);

	const onText = (value: string): void => {
		draft.set(value);
		setText(value);
	};

	const deliver = async (message: string): Promise<ApiResult<unknown>> => {
		let id = chatId;
		const fresh = id === null || (!locked && meta !== null && (meta.engine !== engine || meta.effort !== effort));
		if (fresh) {
			const created = await postJson<{ id: string }>("/api/chats", { engine, effort });
			if (!created.ok) {
				if (engine === "claude" && created.status === 409) {
					setClaudeBlocked(created.error);
					setEngine("agy");
					setEffort(DEFAULT_EFFORT.agy);
				}
				return created;
			}
			id = created.data.id;
		}
		const target = id as string;
		const sent = await postJson(`/api/chats/${target}/messages`, { text: message });
		// A new chat opens once it holds the message, so its first read already shows it.
		if (fresh) select(target);
		else if (sent.ok) update(target, (current) => addUserMessage(current, message));
		return sent;
	};

	const send = async (): Promise<void> => {
		setSending(true);
		setFailure(null);
		const result = await draft.send(deliver);
		setText(draft.text());
		setSending(false);
		setFailure(failureOf(result));
		void chats.reload();
	};

	const stop = (): void => {
		if (chatId) void postJson(`/api/chats/${chatId}/stop`, {}).then((result) => setFailure(failureOf(result)));
	};

	const save = async (message: string): Promise<void> => {
		setActionsFor(null);
		if (!chatId) return;
		const result = await postJson<{ path: string; synced: boolean }>(`/api/chats/${chatId}/save`, { text: message });
		if (result.ok) setToast(result.data.synced ? "Saved to brain" : "Saved, not synced yet");
		else setFailure(failureOf(result));
	};

	const copy = async (message: string): Promise<void> => {
		setActionsFor(null);
		try {
			await navigator.clipboard.writeText(message);
			setToast("Copied");
		} catch {
			setToast("Could not copy");
		}
	};

	const title = useMemo(() => (chatId === null ? "New chat" : (meta?.title ?? "Chat")), [chatId, meta]);

	return (
		<section className="flex h-full flex-col">
			<ScreenHeader
				title={title}
				left={
					<IconButton label="Chats" onClick={() => setDrawer(true)}>
						☰
					</IconButton>
				}
				right={
					<IconButton label="New chat" onClick={() => select(null)}>
						New
					</IconButton>
				}
			/>
			<div className="scroll-y safe-x min-h-0 flex-1">
				{error ? <ErrorLine text={error} /> : null}
				<Messages
					cards={view.cards}
					streamingId={view.streamingId}
					running={view.running}
					onActions={setActionsFor}
					empty={<Empty>Ask anything about the vault. Say “remember…” to save a note.</Empty>}
				/>
			</div>
			{failure ? (
				<div className="safe-x">
					<ErrorLine text={failure.text} offline={failure.offline} />
				</div>
			) : null}
			{toast ? <p className="safe-x py-1 text-center font-mono text-[13px] text-ok">{toast}</p> : null}
			<Composer
				inputRef={input}
				text={text}
				onText={onText}
				onSend={() => void send()}
				onStop={stop}
				sending={sending}
				running={view.running}
				engine={engine}
				effort={effort}
				onEngine={(next) => {
					setEngine(next);
					setEffort(DEFAULT_EFFORT[next]);
				}}
				onEffort={setEffort}
				locked={locked}
				claudeBlocked={claudeBlocked}
			/>
			{drawer ? <Drawer chats={chats.data ?? []} currentId={chatId} onPick={select} onNew={() => select(null)} onClose={() => setDrawer(false)} /> : null}
			{actionsFor !== null ? (
				<Sheet title="Message" onClose={() => setActionsFor(null)}>
					<div className="flex flex-col gap-2">
						<button type="button" className="btn-hot h-12 font-display text-[22px] tracking-wider" onClick={() => void save(actionsFor)}>
							Save to brain
						</button>
						<button type="button" className="h-12 border border-border font-display text-[22px] tracking-wider" onClick={() => void copy(actionsFor)}>
							Copy
						</button>
					</div>
				</Sheet>
			) : null}
		</section>
	);
}
