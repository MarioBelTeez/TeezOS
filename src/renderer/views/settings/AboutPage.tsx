import { useEffect, useState } from "react";
import { useSettings } from "../../state/settings.ts";
import { Section } from "./controls.tsx";

export function AboutPage(): React.JSX.Element {
	const vaultPath = useSettings((s) => s.settings?.vaultPath ?? null);
	const [info, setInfo] = useState<{ version: string; electron: string; userData: string } | null>(null);

	useEffect(() => {
		void window.teez.app.info().then(setInfo);
	}, []);

	return (
		<Section title="About">
			<dl className="grid max-w-3xl grid-cols-[180px_1fr] gap-y-1 font-mono text-[11.5px]">
				<dt className="text-muted">Version</dt>
				<dd>{info?.version ?? "…"}</dd>
				<dt className="text-muted">Electron</dt>
				<dd>{info?.electron ?? "…"}</dd>
				<dt className="text-muted">Brain (vault)</dt>
				<dd>{vaultPath ?? "not found"}</dd>
				<dt className="text-muted">Settings file</dt>
				<dd className="truncate">{info ? `${info.userData}\\settings.json` : "…"}</dd>
			</dl>
		</Section>
	);
}
