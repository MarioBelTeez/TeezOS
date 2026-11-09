import { useEffect, useState } from "react";
import { useSettings } from "../../state/settings.ts";
import { useUi } from "../../state/ui.ts";
import { Button, Row, Section, Toggle } from "./controls.tsx";

/** How TeezAI behaves as an app: notifications, starting with Windows, and first-run setup/tutorial. */
export function GeneralPage(): React.JSX.Element | null {
	const notify = useSettings((s) => s.settings?.agent.notify ?? true);
	const setAgent = useSettings((s) => s.setAgent);
	const [atLogin, setAtLogin] = useState<boolean | null>(null);

	useEffect(() => {
		void window.teez.app.loginItem().then(setAtLogin);
	}, []);

	return (
		<Section title="App">
			<Row
				label="Notifications"
				hint="A chat finishing or waiting while TeezOS is in the background; the server on battery, a guest stopping, a failed backup, a sick pool or a full disk."
			>
				<Toggle value={notify} label="Notifications" onChange={(on) => setAgent({ notify: on })} />
			</Row>
			<Row label="Start with Windows" hint="Keeps run notifications from the server coming. Installed app only.">
				{atLogin === null ? (
					<span className="font-mono text-[11px] text-muted">not available in a dev run</span>
				) : (
					<Toggle value={atLogin} label="Start with Windows" onChange={(on) => void window.teez.app.loginItem(on).then(setAtLogin)} />
				)}
			</Row>
			<Row
				label="Onboarding & tutorial"
				hint="Set up a Starter Brain with preloaded skills, personalize Memories & North Star, or replay the interactive panel docking tutorial."
			>
				<Button
					onClick={() => {
						useUi.getState().setView("desk");
						useUi.getState().setDialog("onboarding");
					}}
				>
					Open setup &amp; tutorial…
				</Button>
			</Row>
		</Section>
	);
}
