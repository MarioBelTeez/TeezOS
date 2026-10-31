import { Globe, Loader2, Plus, X } from "lucide-react";
import { pinUrlOf, useBrowser, type BrowserTab } from "../state/browser.ts";
import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { MAX_BROWSER_PINS, isHttpUrl } from "../../shared/modules.ts";
import { openHomeTab } from "./open.ts";

/**
 * The browser's tab strip: pinned tabs first as icons only, then the rest
 * with their titles. Middle-click closes; right-click pins, unpins, reloads.
 */

export function TabIcon({ tab }: { readonly tab: BrowserTab }): React.JSX.Element {
	if (tab.loading) return <Loader2 size={13} className="shrink-0 animate-spin text-red" />;
	if (tab.favicon) return <img src={tab.favicon} alt="" className="h-3.5 w-3.5 shrink-0" draggable={false} />;
	return <Globe size={13} className="shrink-0" />;
}

function pinTab(tab: BrowserTab): void {
	const settings = useSettings.getState().settings;
	const toast = useUi.getState().toast;
	if (!settings) return;
	const pins = settings.modules.browser.pins;
	// Origin and path only: a query or hash can hold a session token, and settings are a plain file.
	const url = pinUrlOf(tab.url);
	if (!url || !isHttpUrl(url)) {
		toast("Only web pages can be pinned.", "error");
		return;
	}
	if (pins.some((p) => p.url === url)) {
		useBrowser.getState().setPin(tab.id, url);
		return;
	}
	if (pins.length >= MAX_BROWSER_PINS) {
		toast(`${MAX_BROWSER_PINS} pins is the most; unpin one first.`, "error");
		return;
	}
	const title = (tab.title.trim() || new URL(url).hostname).slice(0, 40);
	useSettings.getState().setModules({ browser: { pins: [...pins, { title, url }] } });
	useBrowser.getState().setPin(tab.id, url);
}

function unpinTab(tab: BrowserTab): void {
	const settings = useSettings.getState().settings;
	if (!settings || tab.pin === null) return;
	const pin = tab.pin;
	useSettings.getState().setModules({ browser: { pins: settings.modules.browser.pins.filter((p) => p.url !== pin) } });
	useBrowser.getState().setPin(tab.id, null);
}

function tabMenu(event: React.MouseEvent, tab: BrowserTab): void {
	event.preventDefault();
	const browser = useBrowser.getState();
	useUi.getState().openMenu(event.clientX, event.clientY, [
		tab.pin === null ? { label: "Pin tab", onSelect: () => pinTab(tab) } : { label: "Unpin tab", onSelect: () => unpinTab(tab) },
		{ label: "Reload", onSelect: () => window.teez.browser.action(tab.id, "reload") },
		{ label: "Open in system browser", onSelect: () => window.teez.browser.openExternal(tab.id) },
		{ separator: true },
		{ label: "Close tab", hint: "Ctrl+W", danger: true, onSelect: () => browser.closeTab(tab.id) },
	]);
}

export function BrowserTabs(): React.JSX.Element {
	const tabs = useBrowser((s) => s.tabs);
	const activeId = useBrowser((s) => s.activeId);
	const activate = useBrowser((s) => s.activate);
	const closeTab = useBrowser((s) => s.closeTab);

	return (
		<div role="tablist" aria-label="Browser tabs" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-surface">
			{tabs.map((tab) => {
				const selected = tab.id === activeId;
				const pinned = tab.pin !== null;
				return (
					<div
						key={tab.id}
						role="tab"
						tabIndex={0}
						aria-selected={selected}
						title={`${tab.title}\n${tab.url}`}
						onClick={() => activate(tab.id)}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								activate(tab.id);
							}
						}}
						onMouseDown={(event) => {
							if (event.button === 1) event.preventDefault();
						}}
						onAuxClick={(event) => {
							if (event.button === 1) closeTab(tab.id);
						}}
						onContextMenu={(event) => tabMenu(event, tab)}
						className={`group relative flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border font-condensed text-[12px] font-semibold tracking-wide transition-colors ${
							pinned ? "w-9 justify-center" : "max-w-52 min-w-24 px-2.5"
						} ${selected ? "tab-active bg-surface-2 text-text" : "text-muted hover:bg-white/[0.03] hover:text-text"}`}
					>
						<TabIcon tab={tab} />
						{pinned ? null : (
							<>
								<span className="min-w-0 flex-1 truncate">{tab.title || tab.url}</span>
								<button
									type="button"
									aria-label={`Close ${tab.title}`}
									title="Close (middle-click)"
									onClick={(event) => {
										event.stopPropagation();
										closeTab(tab.id);
									}}
									className={`-mr-1 flex h-4 w-4 shrink-0 items-center justify-center text-muted hover:text-red ${selected ? "" : "opacity-0 group-hover:opacity-100"}`}
								>
									<X size={11} />
								</button>
							</>
						)}
					</div>
				);
			})}
			<button
				type="button"
				title="New tab (Ctrl+T in a page)"
				aria-label="New tab"
				onClick={openHomeTab}
				className="flex w-8 shrink-0 items-center justify-center text-muted hover:text-text"
			>
				<Plus size={14} />
			</button>
		</div>
	);
}
