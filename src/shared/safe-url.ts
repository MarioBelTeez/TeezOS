/**
 * The only URLs Markdown (chat answers, vault notes, previewed files) may put
 * on the page. The window is a file:// page, so anything without a scheme is
 * resolved against the disk: "//host/x.png" becomes the network path
 * \\host\x.png, and Windows answers an SMB server with the user's NTLM hash.
 * Links: http(s), mailto, in-page anchors and plain relative paths (the window
 * never navigates to those). Images: http(s) and inline raster data only.
 */
export function safeMarkdownUrl(url: string, key: string): string {
	const value = url.trim();
	if (!value || /^[\\/][\\/]/.test(value)) return "";
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
	if (key === "src") {
		if (scheme === "http" || scheme === "https") return value;
		return /^data:image\/(png|jpeg|gif|webp);/i.test(value) ? value : "";
	}
	if (scheme === undefined) return value;
	return scheme === "http" || scheme === "https" || scheme === "mailto" ? value : "";
}
