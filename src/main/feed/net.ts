import { isIP } from "node:net";

/**
 * Downloads for read_source: public web only. Every hop of a redirect chain
 * is followed by hand (at most five), its host resolved, and refused when
 * any address is loopback, private, link-local, carrier-grade NAT,
 * multicast or unspecified — so a pasted link (or where it redirects)
 * cannot reach the router, the cloud metadata address or this computer.
 * Bodies are read in a stream and cut off at a cap.
 *
 * Not covered: a host whose DNS answer changes between the check and the
 * request (rebinding); the window is one lookup wide.
 */

export type LookupFn = (host: string) => Promise<string[]>;
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
export type Fetched = { ok: true; bytes: Uint8Array; type: string } | { ok: false; error: string };

const MAX_REDIRECTS = 5;

function publicV4(ip: string): boolean {
	const [a = 0, b = 0] = ip.split(".").map(Number);
	if (a === 0 || a === 10 || a === 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	return a < 224;
}

function publicV6(ip: string): boolean {
	const lower = ip.toLowerCase();
	const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
	if (dotted?.[1]) return publicV4(dotted[1]);
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
	if (hex?.[1] && hex[2]) {
		const high = parseInt(hex[1], 16);
		const low = parseInt(hex[2], 16);
		return publicV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
	}
	// ::, ::1 and the IPv4-compatible ::a.b.c.d forms.
	if (lower.startsWith("::")) return false;
	const first = parseInt(lower.split(":")[0] ?? "0", 16);
	if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
	if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
	if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
	return true;
}

/** True only for an IP address on the public internet. */
export function isPublicAddress(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) return publicV4(ip);
	if (kind === 6) return publicV6(ip);
	return false;
}

async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > max) return null;
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** Why the link's host may not be reached (it does not resolve, or any of its addresses is not public), or null. */
export async function hostRefusal(url: URL, lookup: LookupFn): Promise<string | null> {
	const host = url.hostname.replace(/^\[|\]$/g, "");
	let addresses: string[];
	try {
		addresses = await lookup(host);
	} catch {
		return `Could not find ${host}.`;
	}
	if (addresses.length === 0 || !addresses.every(isPublicAddress)) return `${host} is on the local network; the feed only reads public web pages.`;
	return null;
}

/** A GET of a public http(s) page, redirects followed and checked hop by hop, the body capped at `max` bytes. */
export async function fetchPublic(
	url: string,
	max: number,
	signal: AbortSignal,
	deps: { readonly fetch: FetchFn; readonly lookup: LookupFn },
): Promise<Fetched> {
	const tooBig = `The download is larger than ${Math.round(max / 1024 / 1024)} MB.`;
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
		let parsed: URL;
		try {
			parsed = new URL(current);
		} catch {
			return { ok: false, error: "The link (or a redirect) is not a valid address." };
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: "The link redirected somewhere that is not a web page." };
		const refused = await hostRefusal(parsed, deps.lookup);
		if (refused) return { ok: false, error: refused };
		const response = await deps.fetch(parsed.href, { redirect: "manual", signal });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			await response.body?.cancel().catch(() => undefined);
			if (!location) return { ok: false, error: `The server answered ${response.status} without a destination.` };
			current = new URL(location, parsed.href).href;
			continue;
		}
		if (!response.ok) return { ok: false, error: `The server answered ${response.status}.` };
		const bytes = await readCapped(response, max);
		return bytes ? { ok: true, bytes, type: response.headers.get("content-type") ?? "" } : { ok: false, error: tooBig };
	}
	return { ok: false, error: `More than ${MAX_REDIRECTS} redirects.` };
}
