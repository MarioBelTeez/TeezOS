import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Download, ExternalLink, Lock, LockOpen, Minus, Plus, RotateCw, X } from "lucide-react";
import { useBrowser, type BrowserTab } from "../state/browser.ts";
import { IconButton } from "../shell/IconButton.tsx";

/**
 * Back, forward, reload or stop, the address (a URL, a host, or words to
 * search), zoom, and a way out to the system browser for sites that refuse
 * embedded browsers (Google sign-in).
 */

const shown = (url: string): string => (url === "about:blank" ? "" : url);

export function AddressBar({ tab }: { readonly tab: BrowserTab }): React.JSX.Element {
	const api = window.teez.browser;
	const input = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(shown(tab.url));
	const [editing, setEditing] = useState(false);
	/** A click that focused the field must not undo the select-all on mouse up. */
	const justFocused = useRef(false);
	const focusNonce = useBrowser((s) => s.addressFocus);
	const download = useBrowser((s) => s.download);

	useEffect(() => {
		if (!editing) setValue(shown(tab.url));
	}, [tab.url, tab.id, editing]);

	useEffect(() => {
		if (focusNonce === 0) return;
		input.current?.focus();
		input.current?.select();
	}, [focusNonce]);

	const secure = tab.url.startsWith("https://");
	return (
		<div className="relative flex h-9 shrink-0 items-center gap-0.5 border-b border-border bg-surface px-1.5">
			<IconButton label="Back (Alt+Left)" disabled={!tab.canGoBack} onClick={() => api.action(tab.id, "back")}>
				<ArrowLeft size={15} />
			</IconButton>
			<IconButton label="Forward (Alt+Right)" disabled={!tab.canGoForward} onClick={() => api.action(tab.id, "forward")}>
				<ArrowRight size={15} />
			</IconButton>
			{tab.loading ? (
				<IconButton label="Stop" onClick={() => api.action(tab.id, "stop")}>
					<X size={15} />
				</IconButton>
			) : (
				<IconButton label="Reload (F5)" onClick={() => api.action(tab.id, "reload")}>
					<RotateCw size={14} />
				</IconButton>
			)}
			<div className="mx-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 bg-bg px-2 ring-1 ring-border focus-within:glow">
				{tab.url.startsWith("http") ? (
					<span title={secure ? "Secure connection" : "Not secure: this page is not encrypted"} className={secure ? "text-muted" : "text-red"}>
						{secure ? <Lock size={12} /> : <LockOpen size={12} />}
					</span>
				) : null}
				<input
					ref={input}
					aria-label="Address"
					spellCheck={false}
					value={value}
					placeholder="Search or type a web address"
					onChange={(event) => setValue(event.target.value)}
					onFocus={(event) => {
						setEditing(true);
						justFocused.current = true;
						event.currentTarget.select();
					}}
					onMouseUp={(event) => {
						if (!justFocused.current) return;
						justFocused.current = false;
						event.preventDefault();
					}}
					onBlur={() => {
						justFocused.current = false;
						setEditing(false);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							const text = value.trim();
							if (text) api.navigate(tab.id, text.slice(0, 2048));
							event.currentTarget.blur();
						} else if (event.key === "Escape") {
							setValue(shown(tab.url));
							event.currentTarget.blur();
						}
					}}
					className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text outline-none placeholder:text-muted/60"
				/>
			</div>
			{download?.state === "progress" ? (
				<span title={`Downloading ${download.name}`} className="flex max-w-40 items-center gap-1 px-1 font-mono text-[10px] text-muted">
					<Download size={12} className="shrink-0 animate-pulse text-red" />
					<span className="truncate">{download.name}</span>
				</span>
			) : null}
			<IconButton label="Zoom out (Ctrl+-)" onClick={() => api.zoom(tab.id, -1)}>
				<Minus size={13} />
			</IconButton>
			<button
				type="button"
				title="Reset zoom (Ctrl+0)"
				onClick={() => api.zoom(tab.id, 0)}
				className="w-10 font-mono text-[10px] text-muted hover:text-text"
			>
				{tab.zoom}%
			</button>
			<IconButton label="Zoom in (Ctrl+=)" onClick={() => api.zoom(tab.id, 1)}>
				<Plus size={13} />
			</IconButton>
			<IconButton label="Open in system browser" disabled={!tab.url.startsWith("http")} onClick={() => api.openExternal(tab.id)}>
				<ExternalLink size={14} />
			</IconButton>
			{tab.loading ? <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] animate-pulse bg-linear-to-r from-red to-red-hot" /> : null}
		</div>
	);
}
