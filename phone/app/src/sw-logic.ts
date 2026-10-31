/**
 * What the service worker does with a push and with a tap on its
 * notification, kept pure so it is tested without a browser. The server
 * sends `{ title, body, url, tag }` (phone/server/src/push.ts). A tap only
 * ever opens a path on this origin: a payload naming another site, a
 * protocol-relative `//host` or a backslash trick opens the app's root.
 */

const BASE = "https://teezos.invalid";
const ICON = "/icons/icon-192.png";

const record = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function samePath(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
	// Browsers read "\" as "/" and drop tabs and newlines inside URLs: either can turn "/x" into "//host".
	if (/[\\\u0000-\u001f\u007f]/.test(value)) return "/";
	try {
		const url = new URL(value, BASE);
		return url.origin === BASE ? `${url.pathname}${url.search}${url.hash}` : "/";
	} catch {
		return "/";
	}
}

export function urlForClick(data: unknown): string {
	return samePath(record(data)?.["url"]);
}

export function notificationFor(payload: unknown): { title: string; options: NotificationOptions } | null {
	const fields = record(payload);
	const title = fields?.["title"];
	if (!fields || typeof title !== "string" || title.trim() === "") return null;
	const body = typeof fields["body"] === "string" ? fields["body"] : "";
	const tag = typeof fields["tag"] === "string" && fields["tag"] !== "" ? fields["tag"] : undefined;
	const options: NotificationOptions = { body, icon: ICON, badge: ICON, data: { url: samePath(fields["url"]) } };
	return { title, options: tag === undefined ? options : { ...options, tag } };
}
