import { useSettings } from "../../state/settings.ts";
import { useAgents } from "../../state/agents.ts";
import { AGY_PERMISSIONS, CLAUDE_PERMISSIONS, CODEX_PERMISSIONS, emptyModelsItem } from "../../chat/agent-options.ts";
import { useMemo } from "react";
import { CLAUDE_CHOICES, withCurrentOption } from "../../../shared/models.ts";
import { CLAUDE_EFFORT_OPTIONS, CODEX_EFFORT_OPTIONS } from "../../../shared/effort.ts";
import { Row, Section, Segmented, Select, Toggle, type Option } from "./controls.tsx";

const CLAUDE_OPTIONS: readonly Option[] = [{ id: "", label: "Default" }, ...CLAUDE_CHOICES.map((c) => ({ id: c.id, label: c.label }))];

/** New chats: which agent, model, mode and effort; the chat's text size and the hand-over on switching agent. */
export function ChatPage(): React.JSX.Element | null {
	const agent = useSettings((s) => s.settings?.agent);
	const chat = useSettings((s) => s.settings?.modules.chat);
	const setAgent = useSettings((s) => s.setAgent);
	const setModules = useSettings((s) => s.setModules);
	const agyModels = useAgents((s) => s.agyModels);
	const agyAvailable = useAgents((s) => s.agyAvailable);
	const agyModel = agent?.agyModel ?? "";
	// "" is the CLI's own default; a saved id no longer listed (an old setting,
	// a model Antigravity has dropped) is offered as itself.
	const agyOptions = useMemo(() => withCurrentOption([{ id: "", label: "Default" }, ...agyModels], agyModel), [agyModels, agyModel]);
	const codexModels = useAgents((s) => s.codexModels);
	const codexAvailable = useAgents((s) => s.codexAvailable);
	const codexReason = useAgents((s) => s.codexReason);
	const codexModel = agent?.codexModel ?? "";
	// "" is the account's default Codex model; a saved id no longer listed is offered as itself.
	const codexOptions = useMemo(() => withCurrentOption([{ id: "", label: "Default" }, ...codexModels], codexModel), [codexModels, codexModel]);
	if (!agent || !chat) return null;

	return (
		<>
			<Section title="New chats">
				<Row label="Default agent">
					<Segmented
						value={agent.defaultAgent}
						options={[
							{ id: "claude", label: "Claude Code" },
							{ id: "agy", label: agyAvailable ? "Antigravity" : "Antigravity (not found)" },
							{ id: "codex", label: codexAvailable ? "Codex" : "Codex (not set up)" },
						]}
						onChange={(id) => setAgent({ defaultAgent: id === "agy" || id === "codex" ? id : "claude" })}
					/>
				</Row>
				<Row label="Claude model">
					<Select label="Claude model" value={agent.claudeModel} options={withCurrentOption(CLAUDE_OPTIONS, agent.claudeModel)} onChange={(claudeModel) => setAgent({ claudeModel })} />
				</Row>
				<Row label="Claude mode" hint={CLAUDE_PERMISSIONS.find((p) => p.id === agent.claudePermission)?.hint}>
					<Select label="Claude mode" value={agent.claudePermission} options={CLAUDE_PERMISSIONS} onChange={(id) => setAgent({ claudePermission: id as never })} />
				</Row>
				<Row label="Claude effort" hint={`${CLAUDE_EFFORT_OPTIONS.find((o) => o.id === agent.claudeEffort)?.hint ?? ""}. A level the model lacks runs at the nearest one it has.`}>
					<Select label="Claude effort" value={agent.claudeEffort} options={CLAUDE_EFFORT_OPTIONS} onChange={(id) => setAgent({ claudeEffort: id as never })} />
				</Row>
				<Row label="Antigravity model">
					<Select label="Antigravity model" value={agent.agyModel} options={agyOptions} onChange={(agyModel) => setAgent({ agyModel })} />
				</Row>
				<Row label="Antigravity effort" hint="How hard Gemini thinks; picks the model's low, medium or high variant.">
					<Segmented
						value={agent.agyEffort}
						options={[
							{ id: "low", label: "Low" },
							{ id: "medium", label: "Medium" },
							{ id: "high", label: "High" },
						]}
						onChange={(id) => setAgent({ agyEffort: id as never })}
					/>
				</Row>
				<Row label="Antigravity mode" hint={AGY_PERMISSIONS.find((p) => p.id === agent.agyPermission)?.hint}>
					<Select label="Antigravity mode" value={agent.agyPermission} options={AGY_PERMISSIONS} onChange={(id) => setAgent({ agyPermission: id as never })} />
				</Row>
				<Row label="Codex model" hint={codexAvailable ? "Your ChatGPT plan's models, as Codex lists them." : emptyModelsItem("codex", codexReason).hint}>
					<Select label="Codex model" value={agent.codexModel} options={codexOptions} onChange={(codexModel) => setAgent({ codexModel })} />
				</Row>
				<Row label="Codex effort" hint={CODEX_EFFORT_OPTIONS.find((o) => o.id === agent.codexEffort)?.hint}>
					<Segmented value={agent.codexEffort} options={CODEX_EFFORT_OPTIONS.map((o) => ({ id: o.id, label: o.label }))} onChange={(id) => setAgent({ codexEffort: id as never })} />
				</Row>
				<Row label="Codex mode" hint={CODEX_PERMISSIONS.find((p) => p.id === agent.codexPermission)?.hint}>
					<Select label="Codex mode" value={agent.codexPermission} options={CODEX_PERMISSIONS} onChange={(id) => setAgent({ codexPermission: id as never })} />
				</Row>
			</Section>
			<Section title="Chat">
				<Row label="Text size" hint="Also Ctrl+= and Ctrl+- in a chat; Ctrl+0 back to medium.">
					<Segmented
						value={chat.textSize}
						options={[
							{ id: "s", label: "S" },
							{ id: "m", label: "M" },
							{ id: "l", label: "L" },
						]}
						onChange={(id) => setModules({ chat: { textSize: id === "s" ? "s" : id === "l" ? "l" : "m" } })}
					/>
				</Row>
				<Row label="Hand-over on agent switch" hint="Switching to the other agent's model starts the new chat with a summary of this one.">
					<Toggle value={chat.handover} label="Hand-over on agent switch" onChange={(handover) => setModules({ chat: { handover } })} />
				</Row>
				<Row
					label="Auto-continue after the limit resets"
					hint="When a Claude chat stops at the plan limit, TeezOS sends “continue” itself once it resets. Waits are not kept if TeezOS is closed."
				>
					<Toggle value={chat.autoContinue} label="Auto-continue after the limit resets" onChange={(autoContinue) => setModules({ chat: { autoContinue } })} />
				</Row>
			</Section>
		</>
	);
}
