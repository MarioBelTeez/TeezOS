/**
 * What a page in the built-in browser may use. Harmless permissions are
 * given, sensitive ones are asked about (once per site for this run), and
 * everything else — opening other apps, USB, serial, MIDI SysEx… — is refused.
 */

export type PermissionDecision = "allow" | "deny" | "ask";

const ALWAYS: ReadonlySet<string> = new Set(["clipboard-sanitized-write"]);
/** Full screen is asked too: it hides the app and the address bar, so a page could pose as anything. */
const ASK: ReadonlySet<string> = new Set(["media", "notifications", "geolocation", "clipboard-read", "midi", "display-capture", "fullscreen"]);

export function decidePermission(
	permission: string,
	origin: string,
	grants: ReadonlyMap<string, ReadonlySet<string>>,
): PermissionDecision {
	if (ALWAYS.has(permission)) return "allow";
	if (grants.get(origin)?.has(permission)) return "allow";
	if (ASK.has(permission)) return "ask";
	return "deny";
}

/** The origin a permission is granted to; null for anything that is not a web page. */
export function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
	} catch {
		return null;
	}
}
