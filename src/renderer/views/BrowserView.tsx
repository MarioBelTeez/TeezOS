import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Download, Globe, ShieldAlert, X } from "lucide-react";
import { useBrowser, viewBounds, type Rect } from "../state/browser.ts";
import { useSettings } from "../state/settings.ts";
import { onDeskLayout, useDesk } from "../shell/dock-actions.ts";
import { BrowserTabs } from "../browser/BrowserTabs.tsx";
import { AddressBar } from "../browser/AddressBar.tsx";
import { openHomeTab } from "../browser/open.ts";

/**
 * The Browser panel: tabs, address bar, and a page area the main process
 * draws the active tab's native view over. The view is drawn above every
 * DOM element, so whenever anything should cover it (palette, menus,
 * popovers, Settings) or the panel is not showing, it is told to hide.
 */

/** What each tab was last told, so a resize does not resend the same rect. */
const sent = new Map<string, string>();

function sendBounds(tabId: string, rect: Rect | null): void {
	const key = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : "hidden";
	if (sent.get(tabId) === key) return;
	sent.set(tabId, key);
	window.teez.browser.bounds(tabId, rect);
}

/** The active tab at `rect` (or hidden), every other tab hidden. */
function showOnly(activeId: string | null, rect: Rect | null): void {
	const tabs = useBrowser.getState().tabs;
	for (const id of [...sent.keys()]) if (!tabs.some((t) => t.id === id)) sent.delete(id);
	for (const tab of tabs) if (tab.id !== activeId) sendBounds(tab.id, null);
	if (activeId) sendBounds(activeId, rect);
}

const PERMISSION_LABEL: Readonly<Record<string, string>> = {
	media: "your camera or microphone",
	notifications: "notifications",
	geolocation: "your location",
	"clipboard-read": "your clipboard",
	midi: "MIDI devices",
	"display-capture": "your screen",
	fullscreen: "the full screen",
};

export function BrowserView(): React.JSX.Element {
	const tabs = useBrowser((s) => s.tabs);
	const activeId = useBrowser((s) => s.activeId);
	const overlay = useBrowser((s) => s.overlay);
	const findOpen = useBrowser((s) => s.findOpen);
	const visible = useDesk((s) => s.visible.includes("browser"));
	const page = useRef<HTMLDivElement>(null);
	const active = tabs.find((t) => t.id === activeId) ?? null;

	// First show in this run: the pinned sites (BelTeez Mail), else the home page.
	useEffect(() => {
		if (useBrowser.getState().pinsOpened) return;
		useBrowser.setState({ pinsOpened: true });
		const browser = useSettings.getState().settings?.modules.browser;
		useBrowser.getState().ensurePins(browser?.pins ?? []);
		if (useBrowser.getState().tabs.length === 0) openHomeTab();
	}, []);

	// Keep the native view over the page area, through resizes, dock moves, tab switches and overlays.
	useEffect(() => {
		const element = page.current;
		let frame = 0;
		const measure = (): Rect | null =>
			viewBounds(element?.isConnected ? element.getBoundingClientRect() : null, { visible, overlay });
		const push = (): void => {
			cancelAnimationFrame(frame);
			// Hiding never waits (a menu must not open under the page); placing waits for layout to settle.
			if (measure() === null) showOnly(activeId, null);
			else frame = requestAnimationFrame(() => showOnly(activeId, measure()));
		};
		push();
		const observer = new ResizeObserver(push);
		if (element) observer.observe(element);
		window.addEventListener("resize", push);
		const offLayout = onDeskLayout(push);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", push);
			offLayout();
		};
	}, [visible, overlay, activeId]);

	// Panel closed, or its desk switched away: every page hides (and keeps running).
	useEffect(() => () => showOnly(null, null), []);

	return (
		<div
			data-nav-area="browser"
			className="flex h-full min-h-0 w-full min-w-0 flex-col bg-bg"
			onKeyDown={(event) => {
				const ctrl = event.ctrlKey || event.metaKey;
				const key = event.key.toLowerCase();
				if (ctrl && !event.shiftKey && key === "f" && active) {
					event.preventDefault();
					useBrowser.getState().setFind(true);
				} else if (ctrl && !event.shiftKey && key === "l" && active) {
					event.preventDefault();
					useBrowser.getState().focusAddress();
				}
			}}
		>
			<BrowserTabs />
			{active ? <AddressBar tab={active} /> : null}
			{active && findOpen ? <FindBar tabId={active.id} /> : null}
			<PermissionBar />
			<DownloadBar />
			<div ref={page} className="relative min-h-0 flex-1">
				{/* Under the native view: seen only while it is hidden (an overlay is open) or there is no tab. */}
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
					{active ? (
						<p className="max-w-md truncate px-4 font-condensed text-sm uppercase tracking-wider text-muted/50">{active.title || active.url}</p>
					) : (
						<>
							<Globe size={28} className="text-muted/40" />
							<p className="font-display text-3xl tracking-wider text-muted/60">NO TABS</p>
							<button type="button" onClick={openHomeTab} className="btn-hot cut-corner px-4 py-1.5 font-condensed text-xs uppercase tracking-wider">
								New tab
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function FindBar({ tabId }: { readonly tabId: string }): React.JSX.Element {
	const [text, setText] = useState("");
	const found = useBrowser((s) => s.found);
	const close = (): void => useBrowser.getState().setFind(false);
	const go = (forward: boolean): void => {
		if (text) window.teez.browser.find(tabId, text.slice(0, 2048), forward);
	};
	return (
		<div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-surface-2 px-2">
			<input
				autoFocus
				aria-label="Find in page"
				placeholder="Find in page"
				value={text}
				onChange={(event) => {
					const next = event.target.value;
					setText(next);
					if (next) window.teez.browser.find(tabId, next.slice(0, 2048), true);
					else window.teez.browser.stopFind(tabId);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") go(!event.shiftKey);
					else if (event.key === "Escape") close();
				}}
				className="h-6 w-56 bg-bg px-2 font-mono text-[12px] text-text outline-none ring-1 ring-border focus:glow"
			/>
			<span className="w-16 font-mono text-[10px] text-muted">{text && found ? `${found.active}/${found.matches}` : ""}</span>
			<button type="button" title="Previous (Shift+Enter)" aria-label="Previous match" onClick={() => go(false)} className="flex h-6 w-6 items-center justify-center text-muted hover:text-text">
				<ChevronUp size={14} />
			</button>
			<button type="button" title="Next (Enter)" aria-label="Next match" onClick={() => go(true)} className="flex h-6 w-6 items-center justify-center text-muted hover:text-text">
				<ChevronDown size={14} />
			</button>
			<button type="button" title="Close (Esc)" aria-label="Close find" onClick={close} className="ml-auto flex h-6 w-6 items-center justify-center text-muted hover:text-text">
				<X size={13} />
			</button>
		</div>
	);
}

/** A page wants to save a file: Save puts it in Downloads, Cancel (or a minute of silence) throws it away. */
function DownloadBar(): React.JSX.Element | null {
	const asks = useBrowser((s) => s.downloadAsks);
	const tabs = useBrowser((s) => s.tabs);
	const activeId = useBrowser((s) => s.activeId);
	const answer = useBrowser((s) => s.answerDownload);
	if (asks.length === 0) return null;
	return (
		<div className="shrink-0 border-b border-red/40 bg-red/10">
			{asks.map((ask) => {
				const elsewhere = ask.tabId !== activeId ? tabs.find((t) => t.id === ask.tabId) : null;
				return (
					<div key={ask.id} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
						<Download size={14} className="shrink-0 text-red" />
						<span className="min-w-0 flex-1 truncate">
							Save <span className="font-mono text-text">{ask.name}</span> ({ask.size}) from <span className="font-mono text-text">{ask.host}</span>?
							{elsewhere ? <span className="text-muted"> (in {elsewhere.title || elsewhere.url})</span> : null}
						</span>
						<button type="button" onClick={() => answer(ask.id, true)} className="btn-hot cut-corner px-3 py-0.5 font-condensed text-[11px] uppercase tracking-wider">
							Save
						</button>
						<button
							type="button"
							onClick={() => answer(ask.id, false)}
							className="cut-corner bg-surface px-3 py-0.5 font-condensed text-[11px] uppercase tracking-wider text-muted ring-1 ring-border hover:text-text"
						>
							Cancel
						</button>
					</div>
				);
			})}
		</div>
	);
}

/** A site asking for the camera, notifications…: allowed for this run, or refused. */
function PermissionBar(): React.JSX.Element | null {
	const prompts = useBrowser((s) => s.prompts);
	const tabs = useBrowser((s) => s.tabs);
	const activeId = useBrowser((s) => s.activeId);
	const answer = useBrowser((s) => s.answer);
	if (prompts.length === 0) return null;
	return (
		<div className="shrink-0 border-b border-red/40 bg-red/10">
			{prompts.map((prompt) => {
				const elsewhere = prompt.tabId !== activeId ? tabs.find((t) => t.id === prompt.tabId) : null;
				return (
					<div key={prompt.requestId} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
						<ShieldAlert size={14} className="shrink-0 text-red" />
						<span className="min-w-0 flex-1 truncate">
							<span className="font-mono text-text">{prompt.origin}</span> wants to use {PERMISSION_LABEL[prompt.permission] ?? prompt.permission}
							{elsewhere ? <span className="text-muted"> (in {elsewhere.title || elsewhere.url})</span> : null}
						</span>
						<button type="button" onClick={() => answer(prompt.requestId, true)} className="btn-hot cut-corner px-3 py-0.5 font-condensed text-[11px] uppercase tracking-wider">
							Allow
						</button>
						<button
							type="button"
							onClick={() => answer(prompt.requestId, false)}
							className="cut-corner bg-surface px-3 py-0.5 font-condensed text-[11px] uppercase tracking-wider text-muted ring-1 ring-border hover:text-text"
						>
							Block
						</button>
					</div>
				);
			})}
		</div>
	);
}
