import { effortLabel } from "../../shared/effort.ts";
import { agentDefaults } from "../../shared/agent-defaults.ts";
import { create } from "zustand";
import type { AgentKind } from "../../main/agents/registry.ts";
import type { ChatApproval, ChatEvent, ChatPause } from "../../preload/index.ts";
import { splitDataUrl } from "../../shared/images.ts";
import { useUi } from "./ui.ts";
import { chatToEvict, moveTab } from "../chat/tab-order.ts";
import type { PastedImage } from "../chat/pasted-images.ts";
import {
	EMPTY_CHAT,
	addApproval,
	applyPause,
	addNotice,
	addUserMessage,
	decideApproval,
	reduceChat,
	type Card,
	type ChatView,
} from "../chat/reduce.ts";

/**
 * Every chat the window knows about. A workspace has one active chat; older
 * ones stay open until closed so switching back keeps the conversation.
 */

export type Chat = ChatView & {
	readonly chatId: string;
	readonly workspaceId: string;
	readonly agent: AgentKind;
	readonly model: string;
	readonly permission: string;
	/** See shared/effort.ts: Claude "" = the model's default; Antigravity low / medium / high. */
	readonly effort: string;
	readonly title: string;
	readonly createdAt: number;
};

export type OpenChatOptions = {
	readonly agent?: AgentKind;
	readonly model?: string;
	readonly permission?: string;
	readonly effort?: string;
	readonly resume?: string;
	readonly title?: string;
	/** Cards to show before the first live event, e.g. a resumed transcript. */
	readonly history?: readonly Card[];
	/** Text put in the composer, not sent: the hand-over from a chat with the other agent. */
	readonly prefill?: string;
};

type ChatsState = {
	readonly chats: Readonly<Record<string, Chat>>;
	readonly activeByWorkspace: Readonly<Record<string, string>>;
	/** Tab order per workspace: new chats at the end, rearranged by dragging. Not saved, like the chats. */
	readonly orderByWorkspace: Readonly<Record<string, readonly string[]>>;
	readonly openChat: (workspaceId: string, options?: OpenChatOptions) => Promise<string | null>;
	readonly ensureChat: (workspaceId: string) => Promise<string | null>;
	readonly activate: (workspaceId: string, chatId: string) => void;
	/** Moves a tab before (or `after`) another tab of the same workspace. */
	readonly reorder: (workspaceId: string, moved: string, target: string, after: boolean) => void;
	/** `images` were pasted into the composer; the chat keeps only their thumbnails. */
	readonly send: (chatId: string, text: string, images?: readonly PastedImage[]) => void;
	readonly stop: (chatId: string) => void;
	readonly approve: (chatId: string, requestId: string, decision: "allow" | "deny") => void;
	readonly setModel: (chatId: string, model: string) => void;
	readonly setPermission: (chatId: string, mode: string) => void;
	readonly setEffort: (chatId: string, effort: string) => void;
	readonly close: (chatId: string) => void;
	readonly handleEvent: (envelope: ChatEvent) => void;
	readonly handleApproval: (envelope: ChatApproval) => void;
	readonly handlePause: (change: ChatPause) => void;
	/** Cancel the wait for a limit reset; the banner goes when main confirms. */
	readonly cancelPause: (chatId: string) => void;
};

/** Requests in flight, so two components asking at once get one chat. */
const opening = new Map<string, Promise<string | null>>();
/** Chats closed here: a late event from their dying session must not revive them. */
const closed = new Set<string>();
/**
 * Open chats per workspace before opening another asks to close the oldest
 * idle one; each holds a live agent process. Every open chat has a tab, so
 * none is ever closed without asking.
 */
const MAX_CHATS_PER_WORKSPACE = 12;

export const useChats = create<ChatsState>((set, get) => {
	const update = (chatId: string, change: (chat: Chat) => Chat): void => {
		const chat = get().chats[chatId];
		if (!chat) return;
		set({ chats: { ...get().chats, [chatId]: change(chat) } });
	};

	return {
		chats: {},
		activeByWorkspace: {},
		orderByWorkspace: {},

		openChat: async (workspaceId, options = {}) => {
			// The chat in front of you now is never the one closed to make room:
			// switching agents opens a new chat next to it, not instead of it.
			const previous = get().activeByWorkspace[workspaceId];
			const inWorkspace = Object.values(get().chats).filter((c) => c.workspaceId === workspaceId);
			const evict = chatToEvict(inWorkspace, previous, MAX_CHATS_PER_WORKSPACE);
			if (evict && !window.confirm(`Close the oldest idle chat «${evict.title}»?`)) return null;

			const settings = await window.teez.settings.get();
			const agent = options.agent ?? settings.agent.defaultAgent;
			const defaults = agentDefaults(agent, settings.agent);
			const model = options.model ?? defaults.model;
			const permission = options.permission ?? defaults.permission;
			const effort = options.effort ?? defaults.effort;

			const chatId = await window.teez.chat.create({
				workspaceId,
				agent,
				model,
				permission,
				effort,
				...(options.resume ? { resume: options.resume } : {}),
			});
			if (!chatId) return null;

			const history = options.history ?? [];
			const base: ChatView = {
				...EMPTY_CHAT,
				cards: history,
				nextId: history.length + 1,
				sessionId: options.resume ?? "",
			};
			// Events can arrive before this line runs (a failed start is reported
			// immediately); keep whatever got folded in already.
			const early = get().chats[chatId];
			const chat: Chat = {
				...(early ?? base),
				chatId,
				workspaceId,
				agent,
				model,
				permission,
				effort,
				title: options.title ?? early?.title ?? "New chat",
				createdAt: Date.now(),
			};
			const order = get().orderByWorkspace[workspaceId] ?? [];
			set({
				chats: { ...get().chats, [chatId]: chat },
				activeByWorkspace: { ...get().activeByWorkspace, [workspaceId]: chatId },
				orderByWorkspace: {
					...get().orderByWorkspace,
					[workspaceId]: order.includes(chatId) ? order : [...order, chatId],
				},
			});
			// The composer shows the active chat, so the text lands in the new one,
			// ahead of anything already typed.
			if (options.prefill) useUi.getState().insertIntoComposer(options.prefill, { mode: "prefill" });
			// The chat agreed to above, unless it started a turn in the meantime.
			if (evict && get().chats[evict.chatId]?.running === false) get().close(evict.chatId);
			return chatId;
		},

		ensureChat: (workspaceId) => {
			const active = get().activeByWorkspace[workspaceId];
			if (active && get().chats[active]) return Promise.resolve(active);
			const inFlight = opening.get(workspaceId);
			if (inFlight) return inFlight;
			const promise = get()
				.openChat(workspaceId)
				.finally(() => opening.delete(workspaceId));
			opening.set(workspaceId, promise);
			return promise;
		},

		activate: (workspaceId, chatId) =>
			set({ activeByWorkspace: { ...get().activeByWorkspace, [workspaceId]: chatId } }),

		reorder: (workspaceId, moved, target, after) => {
			const order = get().orderByWorkspace[workspaceId] ?? [];
			const next = moveTab(order, moved, target, after);
			if (next !== order) set({ orderByWorkspace: { ...get().orderByWorkspace, [workspaceId]: next } });
		},

		send: (chatId, text, images = []) => {
			const trimmed = text.trim();
			if (!trimmed && images.length === 0) return;
			const title = trimmed || "Image";
			update(chatId, (chat) => ({
				...chat,
				...addUserMessage(chat, trimmed, images.map((image) => image.thumb)),
				title: chat.title === "New chat" ? title.replace(/\s+/g, " ").slice(0, 60) : chat.title,
			}));
			window.teez.chat.send(chatId, trimmed, images.map((image) => splitDataUrl(image.url)));
		},

		stop: (chatId) => window.teez.chat.stop(chatId),

		approve: (chatId, requestId, decision) => {
			window.teez.chat.approve(chatId, requestId, decision);
			update(chatId, (chat) => ({ ...chat, ...decideApproval(chat, requestId, decision) }));
		},

		setModel: (chatId, model) => {
			void window.teez.chat.setModel(chatId, model);
			update(chatId, (chat) => ({
				...chat,
				...addNotice(chat, `Model: ${model || "default"}`),
				model,
			}));
		},

		setPermission: (chatId, permission) => {
			void window.teez.chat.setPermission(chatId, permission);
			update(chatId, (chat) => ({
				...chat,
				...addNotice(chat, `Permissions: ${permission}`),
				permission,
			}));
		},

		setEffort: (chatId, effort) => {
			window.teez.chat.setEffort(chatId, effort).catch(() => useUi.getState().toast("Could not change the effort of that chat.", "error"));
			update(chatId, (chat) => ({
				...chat,
				...addNotice(chat, `Effort: ${effortLabel(chat.agent, effort)}`),
				effort,
			}));
		},

		close: (chatId) => {
			const chat = get().chats[chatId];
			closed.add(chatId);
			window.teez.chat.close(chatId);
			const chats = { ...get().chats };
			delete chats[chatId];
			const activeByWorkspace = { ...get().activeByWorkspace };
			if (chat && activeByWorkspace[chat.workspaceId] === chatId) {
				delete activeByWorkspace[chat.workspaceId];
			}
			const orderByWorkspace = chat
				? {
						...get().orderByWorkspace,
						[chat.workspaceId]: (get().orderByWorkspace[chat.workspaceId] ?? []).filter((id) => id !== chatId),
					}
				: get().orderByWorkspace;
			set({ chats, activeByWorkspace, orderByWorkspace });
		},

		handleEvent: ({ chatId, event }) => {
			if (closed.has(chatId)) return;
			const existing = get().chats[chatId];
			if (!existing) {
				// An event for a chat whose create() has not returned yet.
				const placeholder: Chat = {
					...reduceChat(EMPTY_CHAT, event),
					chatId,
					workspaceId: "",
					agent: "claude",
					model: "",
					permission: "default",
					effort: "",
					title: "New chat",
					createdAt: Date.now(),
				};
				set({ chats: { ...get().chats, [chatId]: placeholder } });
				return;
			}
			update(chatId, (chat) => ({ ...chat, ...reduceChat(chat, event) }));
		},

		handleApproval: ({ chatId, request }) => {
			if (closed.has(chatId)) return;
			update(chatId, (chat) => ({ ...chat, ...addApproval(chat, request) }));
		},

		handlePause: (change) => {
			if (closed.has(change.chatId)) return;
			update(change.chatId, (chat) => ({ ...chat, ...applyPause(chat, change) }));
		},

		cancelPause: (chatId) => window.teez.chat.cancelPause(chatId),
	};
});
