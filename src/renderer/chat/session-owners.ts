/**
 * Before a past session is deleted: which open chat tabs are that session.
 * A tab that is working blocks the delete (its process is writing the file);
 * idle ones are closed first so nothing points at a session that is gone.
 */

type OpenChat = {
	readonly chatId: string;
	readonly workspaceId: string;
	readonly agent: string;
	readonly sessionId: string;
	readonly running: boolean;
};

export type SessionOwners = { readonly busy: boolean; readonly idle: readonly string[] };

export function sessionOwners(chats: readonly OpenChat[], workspaceId: string, sessionId: string): SessionOwners {
	const owners = chats.filter((c) => c.workspaceId === workspaceId && c.agent === "claude" && c.sessionId !== "" && c.sessionId === sessionId);
	return { busy: owners.some((c) => c.running), idle: owners.filter((c) => !c.running).map((c) => c.chatId) };
}
