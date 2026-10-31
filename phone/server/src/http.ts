import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { isAllowed } from "./auth.ts";
import type { PhoneConfig } from "./config.ts";

export type RouteResult = {
	status: number;
	body?: unknown;
	/** Extra response headers (a stream needs its content-type); the security headers always win. */
	headers?: Readonly<Record<string, string>>;
	stream?: (res: ServerResponse) => void | Promise<void>;
};
export type Route = (req: IncomingMessage, url: URL) => Promise<RouteResult | null>;

const MAX_BODY_BYTES = 1_000_000;
const API_PREFIX = "/api/";

const SECURITY_HEADERS = {
	"content-security-policy": "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
	"x-content-type-options": "nosniff",
} as const;

/** Methods with no side effects; every other /api request is a write. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);
/** A browser's own navigation or the app itself; anything else (same-site included) is another page. */
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

const firstHeader = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * Why a write must be refused as cross-site, or null. `tailscale serve` adds
 * the user's identity to every request his browser makes, so another page could
 * otherwise post to the API: a JSON content-type forces a CORS preflight
 * (which this server never answers), and Sec-Fetch-Site / Origin, when the
 * client sends them, must name this site. The iOS Shortcut sends neither.
 */
function crossSiteRefusal(req: IncomingMessage): { status: number; error: string } | null {
	const site = firstHeader(req.headers["sec-fetch-site"]);
	if (site !== undefined && !ALLOWED_FETCH_SITES.has(site.toLowerCase())) return { status: 403, error: "cross-site request refused" };
	const origin = firstHeader(req.headers["origin"]);
	if (origin !== undefined) {
		// Behind tailscale serve to a unix socket, Host is "localhost" and the real host comes in X-Forwarded-Host (set by tailscaled, the only client of the socket).
		const host = (firstHeader(req.headers["x-forwarded-host"])?.split(",")[0] ?? req.headers.host ?? "").trim().toLowerCase();
		let originHost: string | null = null;
		try {
			originHost = new URL(origin).host.toLowerCase();
		} catch {
			originHost = null;
		}
		if (!originHost || originHost !== host) return { status: 403, error: "cross-site request refused" };
	}
	const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
	if (type !== "application/json") return { status: 415, error: "content-type must be application/json" };
	return null;
}

const MIME: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

/** An error whose message is safe to show the client. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** The request body as JSON; at most 1 MB. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "invalid JSON");
	}
}

/** Reads a refused request's body to its end, at most 1 MB (more is a 413). */
async function discardBody(req: IncomingMessage): Promise<void> {
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

async function runRoutes(routes: readonly Route[], req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
	for (const route of routes) {
		const result = await route(req, url);
		if (result === null) continue;
		if (result.stream) {
			for (const [name, value] of Object.entries({ "cache-control": "no-store", ...result.headers, ...SECURITY_HEADERS })) res.setHeader(name, value);
			res.statusCode = result.status;
			try {
				await result.stream(res);
			} catch (error) {
				console.error("phone: stream route failed", error);
				if (res.headersSent) res.destroy();
				else sendJson(res, 500, { error: "internal error" });
			}
		} else {
			sendJson(res, result.status, result.body ?? {});
		}
		return;
	}
	sendJson(res, 404, { error: "not found" });
}

async function readIfFile(file: string): Promise<Buffer | null> {
	try {
		return await readFile(file);
	} catch {
		return null;
	}
}

/** A file from `appDir`; any path that is not a file inside it gets index.html (SPA routes). */
async function serveStatic(config: PhoneConfig, req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
	if (req.method !== "GET" && req.method !== "HEAD") {
		sendJson(res, 405, { error: "method not allowed" });
		return;
	}
	const root = path.resolve(config.appDir);
	let requested = "";
	try {
		requested = decodeURIComponent(url.pathname);
	} catch {
		sendJson(res, 400, { error: "bad path" });
		return;
	}
	const candidate = path.resolve(root, `.${requested}`);
	const inside = candidate.startsWith(root + path.sep);
	const found = inside ? await readIfFile(candidate) : null;
	const file = found ? candidate : path.join(root, "index.html");
	const data = found ?? (await readIfFile(file));
	if (!data) {
		sendJson(res, 404, { error: "not found" });
		return;
	}
	res.writeHead(200, { ...SECURITY_HEADERS, "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
	res.end(req.method === "HEAD" ? undefined : data);
}

async function handle(config: PhoneConfig, routes: readonly Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isAllowed(req.headers, config.allowedLogin)) {
		sendJson(res, 403, { error: "forbidden" });
		return;
	}
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname.startsWith(API_PREFIX)) {
		const refusal = SAFE_METHODS.has(req.method ?? "GET") ? null : crossSiteRefusal(req);
		if (refusal) {
			// Read (and drop) the body first so the kept-alive connection stays usable.
			await discardBody(req);
			sendJson(res, refusal.status, { error: refusal.error });
			return;
		}
		await runRoutes(routes, req, url, res);
	} else await serveStatic(config, req, url, res);
}

/** The service: Tailscale identity check, then the JSON API routes, then the app's static files. */
export function createPhoneServer(config: PhoneConfig, routes: readonly Route[]): Server {
	return createServer((req, res) => {
		handle(config, routes, req, res).catch((error: unknown) => {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			if (error instanceof HttpError) {
				sendJson(res, error.status, { error: error.message });
				return;
			}
			console.error("phone: unhandled request error", error);
			sendJson(res, 500, { error: "internal error" });
		});
	});
}
