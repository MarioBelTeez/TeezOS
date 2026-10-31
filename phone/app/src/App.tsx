import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PushBanner } from "./components/PushBanner.tsx";
import { parseRoute, pathFor, TABS, type Route, type Tab } from "./route.ts";
import { Chat } from "./screens/Chat.tsx";
import { Feed } from "./screens/Feed.tsx";
import { Runs } from "./screens/Runs.tsx";
import { Server } from "./screens/Server.tsx";

/**
 * The shell: four screens under a bottom tab bar (Chat · Feed · Server ·
 * Runs), opening on Chat. Screens stay mounted when hidden, so a chat keeps
 * its stream and a half-typed draft while the user looks at the server.
 */

/** iOS shrinks only the visual viewport for the keyboard; the shell follows it so the composer stays in view. */
function useKeyboardAwareHeight(): void {
	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const root = document.documentElement;
		const update = (): void => {
			// CSSOM, not a style attribute: allowed under the server's CSP.
			root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
			root.classList.toggle("keyboard-open", viewport.height < window.innerHeight * 0.8);
			if (viewport.offsetTop > 0) window.scrollTo(0, 0);
		};
		update();
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
		};
	}, []);
}

export function App(): ReactNode {
	const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
	useKeyboardAwareHeight();

	const go = useCallback((next: Route) => {
		const path = pathFor(next);
		if (path !== location.pathname) history.pushState(null, "", path);
		setRoute(next);
	}, []);

	useEffect(() => {
		const onPop = (): void => setRoute(parseRoute(location.pathname));
		window.addEventListener("popstate", onPop);
		// A tapped notification while the app is open: the service worker says where to go.
		const onMessage = (event: MessageEvent<unknown>): void => {
			// parseRoute only ever yields one of the app's own routes, whatever the url says.
			const data = event.data as { type?: unknown; url?: unknown } | null;
			if (data?.type === "open" && typeof data.url === "string") go(parseRoute(data.url));
		};
		navigator.serviceWorker?.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("popstate", onPop);
			navigator.serviceWorker?.removeEventListener("message", onMessage);
		};
	}, [go]);

	const show = (tab: Tab): string => (route.tab === tab ? "flex" : "hidden");
	return (
		<div className="app-shell flex flex-col">
			<main className="relative min-h-0 flex-1">
				<div className={`${show("chat")} absolute inset-0 flex-col`}>
					<Chat active={route.tab === "chat"} routeId={route.tab === "chat" ? route.id : null} onRoute={(id) => go({ tab: "chat", id })} />
				</div>
				<div className={`${show("feed")} absolute inset-0 flex-col`}>
					<Feed active={route.tab === "feed"} />
				</div>
				<div className={`${show("server")} absolute inset-0 flex-col`}>
					<Server active={route.tab === "server"} />
				</div>
				<div className={`${show("runs")} absolute inset-0 flex-col`}>
					<Runs active={route.tab === "runs"} runId={route.tab === "runs" ? route.id : null} onRun={(id) => go({ tab: "runs", id })} />
				</div>
			</main>
			{/* Above the tab bar rather than the top: the status bar owns the top inset. */}
			<PushBanner />
			<nav aria-label="Tabs" className="tab-bar safe-bottom glass flex shrink-0 border-t border-border">
				{TABS.map((tab) => (
					<button
						key={tab.id}
						type="button"
						aria-current={route.tab === tab.id ? "page" : undefined}
						onClick={() => go({ tab: tab.id, id: null })}
						className={`h-14 flex-1 font-display text-[20px] tracking-wider ${route.tab === tab.id ? "tab-active" : "text-muted"}`}
					>
						{tab.label}
					</button>
				))}
			</nav>
		</div>
	);
}
