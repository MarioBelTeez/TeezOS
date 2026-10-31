import type { PushPayload } from "../push.ts";
import type { ChatService } from "./chat-service.ts";

/**
 * A Web Push for each finished reply, except while the chat is open on the
 * phone (the user is already reading it there).
 */
export function pushReplies(service: Pick<ChatService, "onReplyDone" | "watching">, notify: (payload: PushPayload) => Promise<void>): () => void {
	return service.onReplyDone((chatId, title, firstLine) => {
		if (service.watching(chatId)) return;
		notify({ title, body: firstLine, url: `/chat/${chatId}`, tag: `chat-${chatId}` }).catch((error: unknown) => console.error("phone: reply push failed", error));
	});
}
