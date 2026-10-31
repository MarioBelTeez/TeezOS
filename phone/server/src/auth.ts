import type { IncomingHttpHeaders } from "node:http";

/**
 * Whether the request comes from the allowed tailnet user. `tailscale serve`
 * adds the header after authenticating the peer (and drops any the client
 * sent); the service listens on a unix socket only teezphone and root
 * (tailscaled) can open, so nothing else can reach it. Node lower-cases
 * header names.
 */
export function isAllowed(headers: IncomingHttpHeaders, allowedLogin: string): boolean {
	const login = headers["tailscale-user-login"];
	// A repeated header arrives as an array: ambiguous, so refused.
	if (typeof login !== "string") return false;
	return login.toLowerCase() === allowedLogin.toLowerCase();
}
