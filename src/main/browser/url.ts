/**
 * What the address bar turns into a page, and which pages the built-in
 * browser may load at all. Only the web: a page cannot send the browser to
 * file:, javascript: or an app's custom scheme (obsidian:, ms-settings:…),
 * and neither can whatever is typed into the address bar.
 */

export const SEARCH_URL = "https://duckduckgo.com/?q=";

const HOST = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/;
const LOCALHOST = /^localhost(:\d+)?(\/.*)?$/i;

/** A typed address as a URL: web URLs as they are, hosts over https, anything else searched. */
export function toUrl(input: string, search: string = SEARCH_URL): string {
	const value = input.trim();
	if (/^https?:\/\//i.test(value) || value === "about:blank") return value;
	if (HOST.test(value) || LOCALHOST.test(value)) return `https://${value}`;
	return `${search}${encodeURIComponent(value)}`;
}

/** True only for http(s) pages with a host, and the empty page. */
export function isAllowedUrl(url: string): boolean {
	if (url === "about:blank") return true;
	try {
		const parsed = new URL(url);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
	} catch {
		return false;
	}
}
