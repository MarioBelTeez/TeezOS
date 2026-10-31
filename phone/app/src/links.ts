const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** A link a reply may open: absolute http(s) or mailto only, else null (drawn as plain text). */
export function safeHref(href: string | undefined): string | null {
	if (!href) return null;
	try {
		const url = new URL(href);
		return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}
