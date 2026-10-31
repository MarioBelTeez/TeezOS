import type { IncomingMessage, ServerResponse } from "node:http";
import { authorize, type Tokens } from "./auth.ts";

export const send = (res: ServerResponse, status: number, body: unknown): void => {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
};

export type HandlerDeps = {
	readonly tokens: Tokens;
	/** The routes, given the one parsed URL the authorisation also used. */
	readonly routes: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
};

/**
 * The request entry: parse the target once (a bad one is a 400, never a throw),
 * authorise with the same URL the routes will see, then dispatch.
 */
export function createHandler(deps: HandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
	return (req, res) => {
		try {
			let url: URL;
			try {
				url = new URL(req.url ?? "/", "https://runner");
			} catch {
				send(res, 400, { error: "Bad request." });
				return;
			}
			const decision = authorize(req.headers.authorization ?? "", deps.tokens, req.method ?? "GET", url.pathname);
			if (decision === "unauthorized") return send(res, 401, { error: "Unauthorized." });
			if (decision === "forbidden") return send(res, 403, { error: "Forbidden." });
			deps.routes(req, res, url).catch((error: unknown) => send(res, 400, { error: error instanceof Error ? error.message : String(error) }));
		} catch (error) {
			console.error("runner: request failed", error);
			try {
				send(res, 500, { error: "Internal error." });
			} catch {
				res.destroy();
			}
		}
	};
}
