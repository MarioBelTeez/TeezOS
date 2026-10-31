import { useBrowser, coveredBy } from "../state/browser.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { revealPanel } from "../shell/dock-actions.ts";
import { MAX_BROWSER_TABS } from "../../shared/modules.ts";

/** Whether links should open in the built-in browser (the module is on). */
export function browserEnabled(): boolean {
	return useSettings.getState().settings?.modules.browser.enabled ?? false;
}

/** A new active tab, or a toast when the strip is full. */
function openActiveTab(url: string): boolean {
	if (useBrowser.getState().openTab(url, { activate: true }) !== null) return true;
	useUi.getState().toast(`${MAX_BROWSER_TABS} browser tabs is the most; close some first.`, "error");
	return false;
}

/** A link from the app (chat, notes) in a new browser tab, with the Browser panel brought forward. */
export function openInBrowser(url: string): void {
	if (openActiveTab(url)) revealPanel("browser");
}

/** A new tab on the home page, ready to type into. */
export function openHomeTab(): void {
	const home = useSettings.getState().settings?.modules.browser.home ?? "https://duckduckgo.com";
	if (openActiveTab(home)) useBrowser.getState().focusAddress();
}

/**
 * Main-process browser events into the store, once for the window's life:
 * the pages keep running (and asking, and downloading) while the panel is closed.
 */
export function wireBrowser(): () => void {
	const api = window.teez.browser;
	const store = useBrowser;
	// Anything drawn over the page area hides the native view (see Review Focus #1).
	const syncOverlay = (): void => {
		const overlay = coveredBy(useUi.getState());
		if (overlay !== store.getState().overlay) store.setState({ overlay });
	};
	syncOverlay();
	// Turning the module off closes every page in the main process (src/main/index.ts); forget them here too.
	const offModule = useSettings.subscribe((state, previous) => {
		const was = previous.settings?.modules.browser.enabled ?? true;
		if (was && state.settings?.modules.browser.enabled === false) store.getState().reset();
	});
	const offs = [
		offModule,
		useUi.subscribe(syncOverlay),
		api.onState((state) => store.getState().update(state)),
		api.onFound((found) => {
			if (found.tabId === store.getState().activeId) store.setState({ found });
		}),
		api.onPermission((request) => store.setState({ prompts: [...store.getState().prompts, request] })),
		api.onPermissionDone(({ requestId }) =>
			store.setState({ prompts: store.getState().prompts.filter((p) => p.requestId !== requestId) }),
		),
		api.onDownload((download) => {
			store.setState({ download });
			if (download.state === "done") useUi.getState().toast(`Downloaded ${download.name} to Downloads.`, "success");
			if (download.state === "failed") {
				useUi.getState().toast(`Download failed: ${download.name}${download.reason ? ` (${download.reason})` : ""}`, "error");
			}
		}),
		api.onDownloadAsk((ask) => store.setState({ downloadAsks: [...store.getState().downloadAsks, ask] })),
		api.onDownloadAsked(({ id }) => store.setState({ downloadAsks: store.getState().downloadAsks.filter((d) => d.id !== id) })),
		api.onOpenTab(({ url }) => openActiveTab(url)),
		// The main process would not open it: the strip must not keep a tab with no page.
		api.onRefused(({ tabId }) => store.getState().closeTab(tabId)),
		api.onOpenRequest(({ url }) => openInBrowser(url)),
		api.onShortcut(({ tabId, action }) => {
			const state = store.getState();
			if (action === "find" && tabId === state.activeId) state.setFind(true);
			else if (action === "address" && tabId === state.activeId) state.focusAddress();
			else if (action === "escape" && state.findOpen) state.setFind(false);
			else if (action === "new-tab") openHomeTab();
			else if (action === "close-tab") state.closeTab(tabId);
		}),
		// App shortcuts pressed inside a page: replayed on the window, where App.tsx listens.
		api.onKey(({ key, ctrl, shift, alt }) => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: ctrl, shiftKey: shift, altKey: alt, bubbles: true, cancelable: true }));
		}),
	];
	return () => {
		for (const off of offs) off();
	};
}
