import { describe, expect, it, vi } from "vitest";
import type { ReplyDone } from "./chat-service.ts";
import { pushReplies } from "./reply-push.ts";

function fakeService(watched: ReadonlySet<string>) {
	let listener: ReplyDone = () => undefined;
	return {
		service: {
			onReplyDone: (l: ReplyDone) => {
				listener = l;
				return () => undefined;
			},
			watching: (chatId: string) => watched.has(chatId),
		},
		finish: (chatId: string) => listener(chatId, "Title", "First line"),
	};
}

describe("pushReplies", () => {
	it("pushes a finished reply for a chat nobody has open", async () => {
		const { service, finish } = fakeService(new Set());
		const notify = vi.fn(async () => undefined);
		pushReplies(service, notify);
		finish("c1");
		expect(notify).toHaveBeenCalledWith({ title: "Title", body: "First line", url: "/chat/c1", tag: "chat-c1" });
	});

	it("skips the push while the user is looking at that chat", () => {
		const { service, finish } = fakeService(new Set(["c1"]));
		const notify = vi.fn(async () => undefined);
		pushReplies(service, notify);
		finish("c1");
		expect(notify).not.toHaveBeenCalled();
	});
});
