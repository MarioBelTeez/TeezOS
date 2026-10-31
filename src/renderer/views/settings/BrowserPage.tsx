import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { MAX_BROWSER_PINS, isHttpUrl } from "../../../shared/modules.ts";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { pinUrlOf } from "../../state/browser.ts";
import { Button, EnabledRow, Row, Section } from "./controls.tsx";

const inputClass = "min-w-0 bg-surface px-2 py-1 font-mono text-[11.5px] text-text outline-none ring-1 ring-border focus:glow";

/** The built-in browser: home page, pinned tabs, and wiping what sites stored. */
export function BrowserPage(): React.JSX.Element | null {
	const browser = useSettings((s) => s.settings?.modules.browser);
	const setModules = useSettings((s) => s.setModules);
	const toast = useUi((s) => s.toast);
	const [home, setHome] = useState(browser?.home ?? "");
	const [pinTitle, setPinTitle] = useState("");
	const [pinUrl, setPinUrl] = useState("");
	const [clearing, setClearing] = useState(false);

	useEffect(() => setHome(browser?.home ?? ""), [browser?.home]);
	if (!browser) return null;
	const pins = browser.pins;

	const saveHome = (): void => {
		const value = home.trim();
		if (!isHttpUrl(value)) {
			toast("The home page must be an http(s) address.", "error");
			return;
		}
		setModules({ browser: { home: value } });
		toast("Home page saved.", "success");
	};

	const addPin = (): void => {
		// Origin and path only, as when pinning a tab: a query can carry a session token.
		const url = pinUrlOf(pinUrl.trim());
		if (!url || !isHttpUrl(url)) return toast("A pin needs an http(s) address.", "error");
		if (pins.some((p) => p.url === url)) return toast("That page is already pinned.", "error");
		if (pins.length >= MAX_BROWSER_PINS) return toast(`${MAX_BROWSER_PINS} pins is the most; remove one first.`, "error");
		const title = pinTitle.trim().slice(0, 40) || new URL(url).hostname;
		setModules({ browser: { pins: [...pins, { title, url }] } });
		setPinTitle("");
		setPinUrl("");
	};

	const move = (index: number, by: number): void => {
		const next = [...pins];
		const [moved] = next.splice(index, 1);
		if (!moved) return;
		next.splice(Math.max(0, Math.min(next.length, index + by)), 0, moved);
		setModules({ browser: { pins: next } });
	};

	const clearData = async (): Promise<void> => {
		if (!window.confirm("Clear the browser's cookies, site data, cache and saved logins? You will be signed out of every site in it.")) return;
		setClearing(true);
		const result = await window.teez.browser.clearData().catch((error: unknown) => ({ ok: false as const, message: String(error) }));
		setClearing(false);
		if (result.ok) toast("Browsing data cleared.", "success");
		else toast(`Could not clear: ${result.message}`, "error");
	};

	return (
		<>
			<Section title="Browser">
				<EnabledRow module="browser" what="the browser" />
				<Row label="Home page" hint="New tabs open here.">
					<div className="flex min-w-0 flex-1 gap-1">
						<input
							value={home}
							aria-label="Home page"
							onChange={(event) => setHome(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") saveHome();
							}}
							className={`${inputClass} flex-1`}
						/>
						<Button disabled={home.trim() === browser.home} onClick={saveHome}>
							Save
						</Button>
					</div>
				</Row>
				<Row label="Browsing data" hint="Cookies, site storage, cache and logins of the browser panel only.">
					<Button tone="danger" disabled={clearing} onClick={() => void clearData()}>
						{clearing ? "Clearing…" : "Clear browsing data"}
					</Button>
				</Row>
			</Section>
			<Section title="Pinned tabs">
				{pins.length === 0 ? (
					<p className="max-w-3xl py-2 font-mono text-[11px] text-muted">No pins. Right-click a tab in the browser to pin it, or add one below.</p>
				) : (
					<ul className="max-w-3xl divide-y divide-border border border-border">
						{pins.map((pin, index) => (
							<li key={pin.url} className="flex items-center gap-3 px-3 py-2">
								<div className="min-w-0 flex-1">
									<p className="text-[14px]">{pin.title}</p>
									<p className="truncate font-mono text-[10.5px] text-muted">{pin.url}</p>
								</div>
								<button type="button" title="Move up" aria-label={`Move ${pin.title} up`} onClick={() => move(index, -1)} className="text-muted hover:text-text">
									<ArrowUp size={14} />
								</button>
								<button type="button" title="Move down" aria-label={`Move ${pin.title} down`} onClick={() => move(index, 1)} className="text-muted hover:text-text">
									<ArrowDown size={14} />
								</button>
								<button
									type="button"
									title="Remove pin"
									aria-label={`Remove ${pin.title}`}
									onClick={() => setModules({ browser: { pins: pins.filter((p) => p.url !== pin.url) } })}
									className="text-muted hover:text-red"
								>
									<X size={14} />
								</button>
							</li>
						))}
					</ul>
				)}
				<div className="mt-3 flex max-w-3xl gap-1">
					<input value={pinTitle} maxLength={40} placeholder="Title" aria-label="Pin title" onChange={(event) => setPinTitle(event.target.value)} className={`${inputClass} w-40`} />
					<input
						value={pinUrl}
						placeholder="https://…"
						aria-label="Pin address"
						onChange={(event) => setPinUrl(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") addPin();
						}}
						className={`${inputClass} flex-1`}
					/>
					<Button disabled={pinUrl.trim() === ""} onClick={addPin}>
						Pin
					</Button>
				</div>
			</Section>
		</>
	);
}
