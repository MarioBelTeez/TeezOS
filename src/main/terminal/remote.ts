/**
 * Claude Code Remote Control from a terminal tab: drive Claude sessions that
 * run on this PC from the Claude phone app or claude.ai/code.
 *
 * Server mode (`claude remote-control`) offers new sessions in the workspace
 * folder; a chat handed over to the phone is the same session resumed with
 * Remote Control on (`claude --resume <id> --remote-control`). The session id
 * comes from the window, so it must be a session id and nothing else: it ends
 * up in a shell command line.
 */

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: unknown): value is string {
	return typeof value === "string" && SESSION_ID.test(value);
}

/** The session name shown in the Claude app. */
const NAME = "TeezOS";

export function remoteControlCommand(sessionId?: string): string {
	if (sessionId === undefined) return `claude remote-control --name ${NAME}`;
	if (!isSessionId(sessionId)) throw new Error("Not a Claude session id.");
	return `claude --resume ${sessionId} --remote-control ${NAME}`;
}
