import type { ServerResponse } from "node:http";
import { isEffort } from "../../../../src/shared/effort.ts";
import { savedNotice, type ChatService } from "../chat/chat-service.ts";
import { isChatId, type Engine } from "../chat/chat-store.ts";
import { HttpError, readJsonBody, type Route, type RouteResult } from "../http.ts";
import { MAX_CAPTURE_CHARS } from "../vault-writer.ts";

/**
 * The chat API. Every chat id is checked to be a UUID of an existing chat
 * before anything else; anything else is a 404. Events stream as SSE
 * (`data: <json>`), with a comment line as a heartbeat so proxies and iOS keep
 * the connection open.
 */

type Deps = {
	readonly service: ChatService;
	readonly saveCapture: (text: string, links: readonly string[]) => Promise<{ path: string; synced: boolean }>;
	/** True when the server has a Claude token (secretsDir/claude-token). */
	readonly claudeEnabled: () => boolean;
	readonly heartbeatMs?: number;
};

const PATH = /^\/api\/chats(?:\/([^/]+)(?:\/(messages|stop|save|events))?)?$/;
const MAX_MESSAGE_CHARS = 20_000;
const HEARTBEAT_MS = 25_000;
const DEFAULT_EFFORT: Readonly<Record<Engine, string>> = { agy: "medium", claude: "" };
export const CLAUDE_TOKEN_MISSING = "Claude needs a token on the server (claude setup-token).";

const NOT_FOUND: RouteResult = { status: 404, body: { error: "not found" } };
const METHOD_NOT_ALLOWED: RouteResult = { status: 405, body: { error: "method not allowed" } };

const record = (body: unknown): Record<string, unknown> => (typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {});

function textField(body: unknown, max: number): string {
	const value = record(body)["text"];
	const text = typeof value === "string" ? value.trim() : "";
	if (text.length === 0) throw new HttpError(400, "text is required");
	if (text.length > max) throw new HttpError(400, `text is over ${max} characters`);
	return text;
}

function newChatOptions(body: unknown, claudeEnabled: boolean): { engine: Engine; effort: string } {
	const { engine: rawEngine = "agy", effort: rawEffort } = record(body);
	if (rawEngine !== "agy" && rawEngine !== "claude") throw new HttpError(400, "engine must be agy or claude");
	if (rawEngine === "claude" && !claudeEnabled) throw new HttpError(409, CLAUDE_TOKEN_MISSING);
	const effort = rawEffort === undefined ? DEFAULT_EFFORT[rawEngine] : rawEffort;
	if (!isEffort(rawEngine, effort)) throw new HttpError(400, "effort is not valid for this engine");
	return { engine: rawEngine, effort };
}

function sse(service: ChatService, chatId: string, heartbeatMs: number): RouteResult {
	return {
		status: 200,
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" },
		stream: (res: ServerResponse) =>
			new Promise<void>((resolve) => {
				res.write(": connected\n\n");
				const unsubscribe = service.subscribe(chatId, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
				const beat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
				res.on("close", () => {
					clearInterval(beat);
					unsubscribe();
					resolve();
				});
			}),
	};
}

export function createChatsRoute(deps: Deps): Route {
	const { service } = deps;
	return async (req, url) => {
		const match = PATH.exec(url.pathname);
		if (!match) return null;
		const [, id, action] = match;

		if (id === undefined) {
			if (req.method === "GET") return { status: 200, body: service.list() };
			if (req.method !== "POST") return METHOD_NOT_ALLOWED;
			const chat = service.create(newChatOptions(await readJsonBody(req), deps.claudeEnabled()));
			return { status: 201, body: { id: chat.id } };
		}

		if (!isChatId(id)) return NOT_FOUND;
		const chat = service.get(id);
		if (!chat) return NOT_FOUND;

		if (action === undefined) return req.method === "GET" ? { status: 200, body: chat } : METHOD_NOT_ALLOWED;
		if (action === "events") return req.method === "GET" ? sse(service, id, deps.heartbeatMs ?? HEARTBEAT_MS) : METHOD_NOT_ALLOWED;
		if (req.method !== "POST") return METHOD_NOT_ALLOWED;

		switch (action) {
			case "messages":
				service.send(id, textField(await readJsonBody(req), MAX_MESSAGE_CHARS));
				return { status: 202, body: {} };
			case "stop":
				await service.stop(id);
				return { status: 200, body: {} };
			case "save": {
				const saved = await deps.saveCapture(textField(await readJsonBody(req), MAX_CAPTURE_CHARS), []);
				service.notice(id, savedNotice(saved));
				return { status: 201, body: saved };
			}
			default:
				return NOT_FOUND;
		}
	};
}
