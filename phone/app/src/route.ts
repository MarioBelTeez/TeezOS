/**
 * The app's four tabs as paths, so a notification can open a chat
 * (`/chat/<id>`), the server (`/server`) or a run (`/runs/<id>`). Anything
 * unknown opens the chat, which is where the app starts.
 */

export type Tab = "chat" | "feed" | "server" | "runs";
export type Route = { readonly tab: Tab; readonly id: string | null };

export const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
	{ id: "chat", label: "Chat" },
	{ id: "feed", label: "Feed" },
	{ id: "server", label: "Server" },
	{ id: "runs", label: "Runs" },
];

const ID = /^[\w-]{1,80}$/;

export function parseRoute(pathname: string): Route {
	const [first, second] = pathname.split("/").filter(Boolean);
	const tab = TABS.find((t) => t.id === first)?.id ?? "chat";
	const id = tab === first && second !== undefined && ID.test(second) ? second : null;
	return { tab, id };
}

export function pathFor(route: Route): string {
	if (route.tab === "chat" && route.id === null) return "/";
	return route.id === null ? `/${route.tab}` : `/${route.tab}/${route.id}`;
}
