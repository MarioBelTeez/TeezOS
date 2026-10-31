import type { SessionSummary } from "../../main/sessions/history.ts";
import { useChats } from "../state/chats.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { revealPanel } from "../shell/dock-actions.ts";
import { foldHistory } from "./reduce.ts";
import { sessionOwners } from "./session-owners.ts";

/** Past-session actions shared by the Past sessions panel and the chat tabs. */

/** Fired after a session is deleted, so lists showing it reload. */
export const SESSIONS_CHANGED = "teez:sessions-changed";
/** A head start for a closed chat's Claude process to let go of the file; the main process retries after. */
const RELEASE_MS = 300;

/** Opens a past session in a new chat tab and continues it with its full context. */
export async function openPastSession(workspaceId: string, session: Pick<SessionSummary, "id" | "title">): Promise<void> {
	const items = await window.teez.sessions.transcript(workspaceId, session.id);
	const settings = useSettings.getState().settings;
	await useChats.getState().openChat(workspaceId, {
		agent: "claude",
		resume: session.id,
		title: session.title,
		history: foldHistory(items).cards,
		...(settings ? { model: settings.agent.claudeModel } : {}),
	});
	revealPanel("chat");
}

/**
 * Asks, then moves the session to the Recycle Bin. Open tabs of it close
 * first; a tab still working blocks it. True when it was deleted.
 */
export async function deletePastSession(workspaceId: string, sessionId: string, title: string): Promise<boolean> {
	const ui = useUi.getState();
	const chats = useChats.getState();
	const owners = sessionOwners(Object.values(chats.chats), workspaceId, sessionId);
	if (owners.busy) {
		ui.toast("That session is still working in a chat tab. Stop it or wait, then delete it.", "error");
		return false;
	}
	if (!window.confirm(`Delete “${title}”?\n\nIt goes to the Recycle Bin, so it can be restored from there.`)) return false;
	if (owners.idle.length > 0) {
		for (const chatId of owners.idle) chats.close(chatId);
		await new Promise((resolve) => setTimeout(resolve, RELEASE_MS));
	}
	const result = await window.teez.sessions.remove(workspaceId, sessionId);
	if (result === "busy") {
		ui.toast("That session file is still open in a Claude process (a terminal or VS Code?). Close it there, then delete again.", "error");
		return false;
	}
	if (result === "missing") {
		// Already gone (deleted elsewhere): drop it from the lists all the same.
		window.dispatchEvent(new CustomEvent(SESSIONS_CHANGED, { detail: { workspaceId, sessionId } }));
		ui.toast("That session was already gone.", "info");
		return false;
	}
	window.dispatchEvent(new CustomEvent(SESSIONS_CHANGED, { detail: { workspaceId, sessionId } }));
	ui.toast("Session moved to the Recycle Bin.", "success");
	return true;
}

export function copyText(text: string, what: string): void {
	void navigator.clipboard.writeText(text).then(
		() => useUi.getState().toast(`${what} copied.`, "success"),
		() => useUi.getState().toast(`Could not copy the ${what.toLowerCase()}.`, "error"),
	);
}
