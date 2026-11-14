import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../../main/update/updater.ts";
import { Row, Section } from "./controls.tsx";

/**
 * TeezOS releases are published on the public MarioBelTeez/TeezOS GitHub
 * repository, so automatic updates work without any GitHub token.
 */
export function UpdatesPage(): React.JSX.Element {
	const [status, setStatus] = useState<UpdateStatus | null>(null);

	useEffect(() => {
		void window.teez.updates.status().then(setStatus);
		return window.teez.updates.onStatus(setStatus);
	}, []);

	return (
		<Section title="Updates">
			<Row label="Automatic updates" hint="Checks public MarioBelTeez/TeezOS releases at launch, every 6 hours, and after wake; updates install on restart.">
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
