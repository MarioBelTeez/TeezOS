import { useEffect, useRef } from "react";
import { agentDefaults } from "../../shared/agent-defaults.ts";
import { ChevronDown, MessageCircleQuestionMark, SendHorizonal, Slash, Square } from "lucide-react";
import type { Workspace } from "../../main/settings/store.ts";
import { CLAUDE_CHOICES, choiceOf, geminiAtEffort, modelForChoice, type Effort, type ModelChoice } from "../../shared/models.ts";
import { effortOptions, isEffort } from "../../shared/effort.ts";

const isAgyEffort = (value: string): value is Effort => isEffort("agy", value);
import { useChats, type Chat } from "../state/chats.ts";
import { useSettings } from "../state/settings.ts";
import { useUi, type ComposerMenu, type MenuItem } from "../state/ui.ts";
import { useAgents, useModelChoices } from "../state/agents.ts";
import { AGY_PERMISSIONS, CLAUDE_PERMISSIONS, CODEX_PERMISSIONS, emptyModelsItem } from "./agent-options.ts";
import { planModelSwitch } from "./model-switch.ts";

/**
 * The row under the text box: which model, how much it may do on its own and
 * how hard it thinks, then Send. Every model of both agents sits in one list; picking one of the
 * other agent opens a new chat beside this one (see `planModelSwitch`).
 */

const GROUPS: readonly { readonly agent: ModelChoice["agent"]; readonly label: string }[] = [
	{ agent: "claude", label: "Claude" },
	{ agent: "agy", label: "Gemini · Antigravity" },
	{ agent: "codex", label: "ChatGPT · Codex" },
];

export function ComposerBar({
	workspace,
	chat,
	canSend,
	onSend,
	onBtw,
	onCommands,
}: {
	readonly workspace: Workspace;
	readonly chat: Chat | null;
	readonly canSend: boolean;
	readonly onSend: () => void;
	readonly onBtw: () => void;
	readonly onCommands: () => void;
}): React.JSX.Element {
	const stop = useChats((s) => s.stop);
	const menu = useUi((s) => s.composerMenu);
	return (
		<div className="flex items-center gap-3 pr-1.5 pb-1.5 pl-3 font-mono text-[length:var(--chat-meta)] text-muted">
			<ModelPicker workspace={workspace} chat={chat} />
			{chat ? <ModePicker chat={chat} /> : null}
			{chat ? <EffortPicker chat={chat} /> : null}
			<div className="flex-1" />
			<BarButton title="Side question (/btw) — answered without adding to the chat" active={menu === "btw"} disabled={!chat} onClick={onBtw}>
				<MessageCircleQuestionMark size={13} />
				<span>btw</span>
			</BarButton>
			<BarButton title="Commands (/)" active={menu === "commands"} disabled={!chat} onClick={onCommands}>
				<Slash size={13} />
			</BarButton>
			{chat?.running ? (
				<button
					type="button"
					onClick={() => stop(chat.chatId)}
					title="Stop (Esc)"
					className="btn-hot flex h-8 w-8 items-center justify-center text-white"
				>
					<Square size={13} fill="currentColor" />
				</button>
			) : (
				<button
					type="button"
					onClick={onSend}
					disabled={!canSend}
					title="Send (Enter)"
					className={`flex h-8 w-8 items-center justify-center transition-[color,filter,box-shadow] ${canSend ? "btn-hot text-white" : "text-muted opacity-40"}`}
				>
					<SendHorizonal size={16} />
				</button>
			)}
		</div>
	);
}

function BarButton({
	title,
	active,
	disabled,
	onClick,
	children,
}: {
	readonly title: string;
	readonly active: boolean;
	readonly disabled: boolean;
	readonly onClick: () => void;
	readonly children: React.ReactNode;
}): React.JSX.Element {
	return (
		<button
			type="button"
			title={title}
			disabled={disabled}
			// Keeps the text box focused, so typing carries on after a click.
			onMouseDown={(event) => event.preventDefault()}
			onClick={onClick}
			className={`flex h-8 items-center gap-1 px-1.5 transition-colors enabled:hover:text-text disabled:opacity-30 ${active ? "glow-text text-red-hot" : ""}`}
		>
			{children}
		</button>
	);
}

/**
 * A picker asked to open from elsewhere (the `/model` and `/mode` commands):
 * it opens its menu from its own button and clears the request.
 */
function useOpenOnRequest(which: ComposerMenu, open: (rect: DOMRect) => void): React.RefObject<HTMLButtonElement | null> {
	const button = useRef<HTMLButtonElement>(null);
	const requested = useUi((s) => s.composerMenu === which);
	const latest = useRef(open);
	latest.current = open;
	useEffect(() => {
		if (!requested) return;
		useUi.getState().setComposerMenu(null);
		const rect = button.current?.getBoundingClientRect();
		if (rect) latest.current(rect);
	}, [requested]);
	return button;
}

/**
 * The bar sits at the bottom of the chat, so its menus give the button's top
 * as their anchor: with no room below they open straight upward from it.
 */
function PickerButton({
	label,
	value,
	title,
	onOpen,
	buttonRef,
}: {
	readonly label: string;
	readonly value: string;
	readonly title: string;
	readonly onOpen: (rect: DOMRect) => void;
	readonly buttonRef?: React.Ref<HTMLButtonElement>;
}): React.JSX.Element {
	return (
		<button
			ref={buttonRef}
			type="button"
			title={title}
			onClick={(event) => onOpen(event.currentTarget.getBoundingClientRect())}
			className="flex min-w-0 items-center gap-1 hover:text-text"
		>
			<span className="opacity-60">{label}</span>
			<span className="truncate text-text">{value}</span>
			<ChevronDown size={10} className="shrink-0" />
		</button>
	);
}

/**
 * What the current chat runs on. A model id no longer offered (an old
 * setting, a Gemini Antigravity has dropped) shows as itself.
 */
function modelLabel(chat: Chat | null, choices: readonly ModelChoice[]): string {
	if (!chat) return CLAUDE_CHOICES[0]?.label ?? "";
	const choice = choiceOf(chat.agent, chat.model, choices);
	if (choice) return choice.label;
	return chat.model || "Default";
}

function ModelPicker({ workspace, chat }: { readonly workspace: Workspace; readonly chat: Chat | null }): React.JSX.Element {
	const agyModels = useAgents((s) => s.agyModels);
	const codexReason = useAgents((s) => s.codexReason);
	const choices = useModelChoices();
	const settings = useSettings((s) => s.settings);
	// A Gemini chat's own effort picks the variant; otherwise the default for new chats.
	const effort: Effort = chat?.agent === "agy" && isAgyEffort(chat.effort) ? chat.effort : (settings?.agent.agyEffort ?? "medium");
	const current = chat ? choiceOf(chat.agent, chat.model, choices) : undefined;

	const pick = async (choice: ModelChoice, model: string): Promise<void> => {
		// Before the panel's first chat exists, wait for it (joining the open
		// already in flight) rather than racing it into a second chat; the
		// pick then applies to that chat like any other.
		let from = chat;
		if (!from) {
			const id = await useChats.getState().ensureChat(workspace.id);
			from = id ? (useChats.getState().chats[id] ?? null) : null;
		}
		// With the hand-over turned off in Settings, the new chat starts blank.
		const handover = settings?.modules.chat.handover ?? true;
		const plan = planModelSwitch(
			from ? { agent: from.agent, running: from.running, cards: handover ? from.cards : [], title: from.title } : null,
			choice,
			model,
		);
		if (plan.kind === "in-place") {
			if (!from || plan.model === from.model) return;
			useChats.getState().setModel(from.chatId, plan.model);
			return;
		}
		const permission = settings ? agentDefaults(plan.agent, settings.agent).permission : undefined;
		await useChats.getState().openChat(workspace.id, {
			agent: plan.agent,
			model: plan.model,
			...(permission ? { permission } : {}),
			// A hand-over continues the same work: the tab keeps its name rather
			// than taking the first words of "Context from the … chat".
			...(from && plan.prefill ? { title: from.title } : {}),
			prefill: plan.prefill,
		});
		// The switch changes this chat only: the defaults change in Settings → Chat or with a preset.
	};

	const open = (rect: DOMRect): void => {
		const available = agyModels.map((m) => m.id);
		const items: MenuItem[] = [];
		for (const group of GROUPS) {
			items.push({ separator: true, label: group.label });
			// A model no longer offered stays listed as the current one, by its id; picking it changes nothing.
			if (chat && chat.agent === group.agent && chat.model && !current) {
				items.push({ label: `● ${chat.model}`, hint: "no longer listed", onSelect: () => undefined });
			}
			const offered = choices.filter((c) => c.agent === group.agent);
			if (offered.length === 0) items.push({ ...emptyModelsItem(group.agent, codexReason), disabled: true, onSelect: () => undefined });
			for (const choice of offered) {
				const model = modelForChoice(choice, effort, available);
				items.push({
					label: `${choice === current ? "● " : "  "}${choice.label}`,
					...(model === null ? { disabled: true, hint: "not available" } : {}),
					onSelect: () => {
						if (model !== null) void pick(choice, model);
					},
				});
			}
		}
		useUi.getState().openMenu(rect.left, rect.bottom + 2, items, rect.top - 2);
	};

	const button = useOpenOnRequest("model", open);
	return <PickerButton buttonRef={button} label="model" value={modelLabel(chat, choices)} title="Model — the other agent's models open a new chat" onOpen={open} />;
}

/** A labelled value that opens a menu of options; the mode and effort pickers. */
function Picker({
	which,
	label,
	value,
	options,
	onChange,
}: {
	/** The composer menu (`/mode`, `/effort`) that opens this picker from the command menu. */
	readonly which: ComposerMenu;
	readonly label: string;
	readonly value: string;
	readonly options: readonly { readonly id: string; readonly label: string; readonly hint?: string }[];
	readonly onChange: (id: string) => void;
}): React.JSX.Element {
	const current = options.find((o) => o.id === value) ?? options[0];
	const open = (rect: DOMRect): void =>
		useUi.getState().openMenu(
			rect.left,
			rect.bottom + 2,
			options.map((o) => ({ label: `${o.id === value ? "● " : "  "}${o.label}`, ...(o.hint ? { hint: o.hint } : {}), onSelect: () => onChange(o.id) })),
			rect.top - 2,
		);
	const button = useOpenOnRequest(which, open);
	return <PickerButton buttonRef={button} label={label} value={current?.label ?? value} title={current?.hint ?? label} onOpen={open} />;
}

function ModePicker({ chat }: { readonly chat: Chat }): React.JSX.Element {
	return (
		<Picker
			which="mode"
			label="mode"
			value={chat.permission}
			options={chat.agent === "claude" ? CLAUDE_PERMISSIONS : chat.agent === "codex" ? CODEX_PERMISSIONS : AGY_PERMISSIONS}
			onChange={(mode) => {
				useChats.getState().setPermission(chat.chatId, mode);
			}}
		/>
	);
}

/**
 * How hard the chat's agent thinks. Claude applies it from the next request,
 * mid-session too. For Gemini the level is part of the model, so the chat
 * also moves to that model's variant. It changes this chat only, never the
 * defaults (Settings → Chat or a preset set those).
 */
function EffortPicker({ chat }: { readonly chat: Chat }): React.JSX.Element {
	const agyModels = useAgents((s) => s.agyModels);
	return (
		<Picker
			which="effort"
			label="effort"
			value={chat.effort}
			options={effortOptions(chat.agent)}
			onChange={(effort) => {
				if (effort === chat.effort) return;
				const chats = useChats.getState();
				chats.setEffort(chat.chatId, effort);
				if (chat.agent === "claude") return;
				const variant = geminiAtEffort(chat.model, effort as Effort, agyModels.map((m) => m.id));
				if (variant) chats.setModel(chat.chatId, variant);
			}}
		/>
	);
}
