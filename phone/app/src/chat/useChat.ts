import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_CHAT, type ChatView } from "../../../../src/renderer/chat/reduce.ts";
import { request } from "../api.ts";
import { foldEvent, parseChatEvent, reconnectDelay, settles, viewFromSnapshot, type ChatSnapshot } from "../chat-stream.ts";

export type ChatMeta = Pick<ChatSnapshot, "id" | "title" | "engine" | "effort">;

/**
 * One chat, live: opens the event stream, then reads the chat (there is no
 * snapshot on connect) and folds what follows. EventSource retries a dropped
 * connection by itself, but gives up for good on a non-200 answer (a 502
 * while the service restarts, a 404 for a chat that is gone). Then the chat
 * is re-read, which shows the error, and the stream reopens on a backoff
 * (reconnectDelay) while the app is visible. Coming back to the app reopens
 * it too, since iOS drops the connection of a backgrounded web app.
 */
export function useChat(chatId: string | null) {
	const [view, setView] = useState<ChatView>(EMPTY_CHAT);
	const [meta, setMeta] = useState<ChatMeta | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [epoch, setEpoch] = useState(0);
	const current = useRef(chatId);
	current.current = chatId;

	// A different chat starts blank; a reconnect of the same chat keeps what is on screen.
	useEffect(() => {
		setView(EMPTY_CHAT);
		setMeta(null);
		setError(null);
	}, [chatId]);

	useEffect(() => {
		if (chatId === null) return;
		let closed = false;
		let ready = false;
		let attempt = 0;
		let source: EventSource | null = null;
		let retry: ReturnType<typeof setTimeout> | null = null;
		/** Set when the chat answered 404: a deleted chat is never retried. */
		let gone = false;

		const refresh = async (): Promise<void> => {
			const result = await request<ChatSnapshot>(`/api/chats/${chatId}`);
			if (closed) return;
			if (!result.ok) {
				if (result.status === 404) {
					gone = true;
					if (retry) clearTimeout(retry);
					retry = null;
					source?.close();
					setError("That chat is gone.");
				} else setError(result.error);
				return;
			}
			ready = true;
			setError(null);
			setView(viewFromSnapshot(result.data));
			const { id, title, engine, effort } = result.data;
			setMeta({ id, title, engine, effort });
		};

		const open = (): void => {
			retry = null;
			if (gone || closed) return;
			const stream = new EventSource(`/api/chats/${chatId}/events`);
			source = stream;
			stream.onopen = () => {
				attempt = 0;
				void refresh();
			};
			stream.onmessage = (message: MessageEvent<string>) => {
				const event = parseChatEvent(message.data);
				// Before the first snapshot, the snapshot already holds what streams in.
				if (!event || !ready) return;
				setView((view) => foldEvent(view, event));
				if (settles(event)) void refresh();
			};
			stream.onerror = () => {
				ready = false;
				if (stream.readyState !== EventSource.CLOSED || closed || gone) return;
				// Closed for good: say why, then try again later (coming back to the app retries too) unless the chat is gone.
				void refresh();
				if (document.visibilityState === "visible") retry = setTimeout(open, reconnectDelay(attempt++));
			};
		};

		open();
		return () => {
			closed = true;
			if (retry) clearTimeout(retry);
			source?.close();
		};
	}, [chatId, epoch]);

	useEffect(() => {
		const onVisible = (): void => {
			if (document.visibilityState === "visible") setEpoch((n) => n + 1);
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, []);

	/** For the composer: the message the server accepted, shown at once (the stream does not echo it). */
	const update = useCallback((forChat: string, change: (view: ChatView) => ChatView) => {
		if (current.current === forChat) setView(change);
	}, []);

	return { view, meta, error, update, reconnect: () => setEpoch((n) => n + 1) };
}
