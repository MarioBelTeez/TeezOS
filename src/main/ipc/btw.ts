import { ipcMain, type BrowserWindow } from "electron";
import { deleteSession, query } from "@anthropic-ai/claude-agent-sdk";
import { runBtw } from "../claude/btw.ts";
import type { QueryFn } from "../claude/service.ts";
import { runAgyBtw } from "../agy/btw.ts";
import { AgySession } from "../agy/session.ts";
import { BtwService, btwChatOf, type BtwEvent } from "../agents/btw-service.ts";
import type { ChatRegistry } from "../agents/registry.ts";
import type { SettingsStore } from "../settings/store.ts";
import { locateAgy, locateClaude } from "./chat.ts";

/**
 * `/btw` over IPC: `btw:ask` (chatId, question) → btwId | { error },
 * `btw:cancel` (btwId), and the answer as `btw:event` { btwId, kind, text }.
 * Returns the function that cancels whatever is still running at quit.
 */
export function registerBtwIpc(
	store: SettingsStore,
	registry: ChatRegistry,
	getWindow: () => BrowserWindow | null,
): () => void {
	const emit = (event: BtwEvent): void => {
		const window = getWindow();
		if (window && !window.isDestroyed()) window.webContents.send("btw:event", event);
	};

	const service = new BtwService({
		chat: (chatId) => btwChatOf(registry, chatId),
		startClaude: (request) => {
			const located = locateClaude();
			if (!located.ok) return { error: located.reason };
			return runBtw({
				query: query as unknown as QueryFn,
				claudePath: located.path,
				...request,
				// Scoped to the chat's project folder, where the fork was written.
				deleteSession: (id) => deleteSession(id, { dir: request.cwd }),
			});
		},
		startAgy: (request) => {
			const agyPath = locateAgy();
			if (!agyPath) return { error: "Antigravity's CLI (agy) was not found." };
			const { cwd, model, question, ...hooks } = request;
			return runAgyBtw({
				// Plan mode: a side question reads and answers, it never edits. sideQuestion turns off
				// slash-command and skill expansion. Not isolated further (gap, see AgySessionDeps.sideQuestion):
				// agy has no per-run switch for MCP servers or tools, and no command to delete the
				// one-off conversation afterwards, so it stays in agy's history.
				createSession: (onEvent) =>
					new AgySession({ agyPath, cwd, model, permission: "plan", effort: store.get().agent.agyEffort, sideQuestion: true, onEvent }),
				question,
				...hooks,
			});
		},
		emit,
	});

	// No side question outlives its chat (closed, its workspace unpinned, or quit).
	const stopListening = registry.onClose((chatId) => service.cancelChat(chatId));

	ipcMain.handle("btw:ask", (_event, chatId: unknown, question: unknown) => service.ask(chatId, question));
	ipcMain.on("btw:cancel", (_event, btwId: unknown) => service.cancel(btwId));

	return () => {
		stopListening();
		service.disposeAll();
	};
}
