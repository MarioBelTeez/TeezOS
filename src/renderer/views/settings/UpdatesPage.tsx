import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../../main/update/updater.ts";
import { Row, Section } from "./controls.tsx";

/**
 * TeezAI's releases are private, so updating needs a read-only GitHub token.
 * It is checked against GitHub, then kept encrypted in the main process; the
 * window only learns whether one is saved.
 */
export function UpdatesPage(): React.JSX.Element {
	const [status, setStatus] = useState<UpdateStatus | null>(null);
	const [hasToken, setHasToken] = useState<boolean | null>(null);
	const [editing, setEditing] = useState(false);
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void window.teez.updates.status().then(setStatus);
		void window.teez.updates.hasToken().then(setHasToken);
		return window.teez.updates.onStatus(setStatus);
	}, []);

	const save = async (): Promise<void> => {
		setBusy(true);
		setError(null);
		const result = await window.teez.updates.setToken(token);
		setBusy(false);
		if (!result.ok) {
			setError(result.message);
			return;
		}
		setToken("");
		setEditing(false);
		setHasToken(true);
	};

	const remove = async (): Promise<void> => {
		await window.teez.updates.clearToken();
		setHasToken(false);
	};

	return (
		<Section title="Updates">
			<Row label="Automatic updates" hint="Checks at launch, every 6 hours and after the PC wakes; a new version waits for your restart.">
				<span className="font-mono text-[11.5px]" title={status?.state === "disabled" ? status.reason : undefined}>
					{describeUpdate(status)}
				</span>
				{status?.state === "ready" ? (
					<button type="button" onClick={() => window.teez.updates.install()} className="cut-corner bg-red px-3 py-1 font-condensed text-[11px] uppercase tracking-wider">
						Restart now
					</button>
				) : status?.state === "failed" || status?.state === "current" ? (
					<button type="button" onClick={() => window.teez.updates.check()} className="ml-3 font-mono text-[11px] text-muted hover:text-text">
						check now
					</button>
				) : null}
			</Row>
			<Row label="GitHub token" hint="Read-only on MarioBelTeez/TeezAI. Stored encrypted on this PC.">
				{hasToken && !editing ? (
					<div className="flex items-center gap-3 font-mono text-[11.5px]">
						<span className="text-[#73c991]">saved</span>
						<button type="button" onClick={() => setEditing(true)} className="text-muted hover:text-text">
							replace
						</button>
						<button type="button" onClick={() => void remove()} className="text-muted hover:text-red">
							remove
						</button>
					</div>
				) : (
					<div className="min-w-0 flex-1 space-y-1">
						<div className="flex gap-1">
							<input
								type="password"
								value={token}
								onChange={(event) => setToken(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && token.trim()) void save();
								}}
								placeholder="github_pat_…"
								className="min-w-0 flex-1 bg-surface px-2 py-1 font-mono text-[11px] text-text outline-none ring-1 ring-border focus:glow"
							/>
							<button type="button" disabled={!token.trim() || busy} onClick={() => void save()} className="cut-corner bg-red px-2.5 font-condensed text-[11px] uppercase disabled:opacity-40">
								{busy ? "Checking…" : "Save"}
							</button>
						</div>
						{error ? <p className="font-mono text-[10.5px] text-red">{error}</p> : null}
						<a
							href="https://github.com/settings/personal-access-tokens/new"
							target="_blank"
							rel="noreferrer"
							className="font-mono text-[10px] text-muted hover:text-text"
						>
							Create one: fine-grained, only TeezAI, Contents read-only →
						</a>
					</div>
				)}
			</Row>
		</Section>
	);
}

function describeUpdate(status: UpdateStatus | null): string {
	if (!status) return "…";
	switch (status.state) {
		case "disabled":
			return /installed build/i.test(status.reason) ? "off in a dev run" : "off — no token";
		case "checking":
			return "checking…";
		case "current":
			return `up to date (${status.version})`;
		case "available":
			return `${status.version} found, downloading…`;
		case "downloading":
			return `downloading ${status.percent}%`;
		case "ready":
			return `${status.version} ready`;
		case "failed":
			return status.retryAt
				? `${status.message}; trying again at ${new Date(status.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
				: `failed: ${status.message}`;
	}
}
