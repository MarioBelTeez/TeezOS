import { useEffect, useState } from "react";
import { useSettings } from "../../state/settings.ts";
import { useAgents } from "../../state/agents.ts";
import { useUi } from "../../state/ui.ts";
import { showView } from "../../shell/dock-actions.ts";
import { Button, EnabledRow, Note, Row, Section, Segmented } from "./controls.tsx";

/**
 * The smaller sections: Agents, Server and Automations (a switch and their
 * connection) and Discord. Connecting a server or the runner still happens in
 * its own view, where the steps are explained.
 */

export function AgentsPage(): React.JSX.Element {
	const agyAvailable = useAgents((s) => s.agyAvailable);
	const agyModels = useAgents((s) => s.agyModels);
	return (
		<Section title="Agents">
			<EnabledRow module="agents" what="the Agents view" />
			<Row label="Antigravity CLI" hint="Antigravity runs show in the tree when Claude starts them.">
				<span className={`font-mono text-[11.5px] ${agyAvailable ? "text-[#73c991]" : "text-muted"}`}>
					{agyAvailable ? `found · ${agyModels.length} models` : "not found"}
				</span>
			</Row>
		</Section>
	);
}

type Connection = { readonly configured: boolean; readonly detail: string };

function ConnectionRows({
	label,
	load,
	disconnect,
	view,
	confirmText,
}: {
	readonly label: string;
	readonly load: () => Promise<Connection>;
	readonly disconnect: () => Promise<void>;
	readonly view: "server" | "automations";
	readonly confirmText: string;
}): React.JSX.Element {
	const enabled = useSettings((s) => s.settings?.modules[view].enabled ?? true);
	const [connection, setConnection] = useState<Connection | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		load().then(
			(c) => live && setConnection(c),
			(e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
		);
		return () => {
			live = false;
		};
	}, [load]);

	const drop = async (): Promise<void> => {
		if (!window.confirm(confirmText)) return;
		try {
			await disconnect();
			setConnection({ configured: false, detail: "" });
		} catch (e) {
			useUi.getState().toast(`Could not disconnect: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	};

	return (
		<Row label={label} hint={connection?.configured ? connection.detail : "Connect from its view; the steps are explained there."}>
			<span className={`font-mono text-[11.5px] ${connection?.configured ? "text-[#73c991]" : "text-muted"}`}>
				{error ? `unknown: ${error}` : connection === null ? "…" : connection.configured ? "connected" : "not connected"}
			</span>
			<div className="ml-auto flex gap-2">
				<Button disabled={!enabled} title={enabled ? undefined : "Turn it on first"} onClick={() => showView(view)}>
					Open the view
				</Button>
				{connection?.configured ? (
					<Button tone="danger" onClick={() => void drop()}>
						Disconnect
					</Button>
				) : null}
			</div>
		</Row>
	);
}

const loadServer = async (): Promise<Connection> => {
	const s = await window.teez.server.status();
	return { configured: s.configured, detail: [s.baseUrl, s.node ? `node ${s.node}` : null, s.tokenId].filter(Boolean).join(" · ") };
};
const disconnectServer = (): Promise<void> => window.teez.server.disconnect();

export function ServerPage(): React.JSX.Element {
	return (
		<Section title="Server">
			<EnabledRow module="server" what="the Server view" />
			<ConnectionRows
				label="Proxmox"
				view="server"
				load={loadServer}
				disconnect={disconnectServer}
				confirmText="Disconnect from the server? Its API token stays on the server; TeezOS forgets it."
			/>
		</Section>
	);
}

const loadAutomations = async (): Promise<Connection> => {
	const s = await window.teez.automations.status();
	return { configured: s.configured, detail: s.baseUrl ?? "" };
};
const disconnectAutomations = (): Promise<void> => window.teez.automations.disconnect();

export function AutomationsPage(): React.JSX.Element {
	return (
		<Section title="Automations">
			<EnabledRow module="automations" what="Automations" />
			<ConnectionRows
				label="Runner"
				view="automations"
				load={loadAutomations}
				disconnect={disconnectAutomations}
				confirmText="Disconnect from the runner? Jobs keep running on the server; TeezOS stops showing them."
			/>
			<Note>Run notifications follow the Notifications switch under General.</Note>
		</Section>
	);
}

export function DiscordPage(): React.JSX.Element | null {
	const presence = useSettings((s) => s.settings?.agent.presence);
	const setAgent = useSettings((s) => s.setAgent);
	if (!presence) return null;
	return (
		<Section title="Discord">
			<Row
				label="Discord status"
				hint={
					presence === "private"
						? "Shows that Claude is working or waiting, never which workspace."
						: presence === "on"
							? "Shows Playing TeezOS, what Claude is doing and the workspace, while the Discord app is open."
							: "Nothing is shown on Discord."
				}
			>
				<Segmented
					value={presence}
					options={[
						{ id: "on", label: "On" },
						{ id: "private", label: "Hide names" },
						{ id: "off", label: "Off" },
					]}
					onChange={(id) => setAgent({ presence: id === "private" || id === "off" ? id : "on" })}
				/>
			</Row>
		</Section>
	);
}
