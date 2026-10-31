import { useCallback, useEffect, useState } from "react";
import { useFeed } from "../../state/feed.ts";
import { useUi } from "../../state/ui.ts";
import { DEFAULT_FEED_PREFS, ENGINE_LABEL, MAX_GEMINI_KEY, type EngineChoice, type EngineId, type EngineStatus, type FeedPrefs, type ModelInfo } from "../../../shared/feed-engine.ts";
import { Button, EnabledRow, Note, Row, Section, Select, type Option } from "./controls.tsx";

/**
 * Feed the Brain: which model reads a source (Gemini, Groq or Claude), its
 * model, and the keys. A key goes to the main process and is stored
 * encrypted; this page only ever learns whether one is saved.
 */

const ENGINE_OPTIONS: readonly Option[] = [
	{ id: "auto", label: "Auto (Gemini, then Groq, then Claude)" },
	{ id: "gemini", label: "Gemini" },
	{ id: "groq", label: "Groq" },
	{ id: "claude", label: "Claude" },
];

/** A secret field: "saved" with a replace link, or a password input with Save. Never shows the value. */
function KeyRow({
	label,
	hint,
	placeholder,
	has,
	looksValid,
	maxLength,
	onSave,
}: {
	readonly label: string;
	readonly hint: string;
	readonly placeholder: string;
	readonly has: boolean | null;
	readonly looksValid: (key: string) => boolean;
	readonly maxLength: number;
	readonly onSave: (key: string) => Promise<boolean>;
}): React.JSX.Element {
	const [replacing, setReplacing] = useState(false);
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const ready = looksValid(key.trim());

	const save = async (): Promise<void> => {
		setBusy(true);
		const ok = await onSave(key.trim());
		setBusy(false);
		if (!ok) return;
		setKey("");
		setReplacing(false);
	};

	return (
		<Row label={label} hint={hint}>
			{has && !replacing ? (
				<div className="flex items-center gap-3 font-mono text-[11.5px]">
					<span className="text-[#73c991]">saved</span>
					<button type="button" onClick={() => setReplacing(true)} className="text-muted hover:text-text">
						replace
					</button>
				</div>
			) : (
				<div className="flex min-w-0 flex-1 gap-1">
					<input
						type="password"
						value={key}
						maxLength={maxLength}
						placeholder={has === false ? `not set — ${placeholder}` : placeholder}
						aria-label={label}
						autoComplete="off"
						onChange={(event) => setKey(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && ready) void save();
							if (event.key === "Escape" && has) {
								event.preventDefault();
								setReplacing(false);
							}
						}}
						className="min-w-0 flex-1 bg-surface px-2 py-1 font-mono text-[11px] text-text outline-none ring-1 ring-border focus:glow"
					/>
					<Button tone="hot" disabled={busy || !ready} onClick={() => void save()}>
						{busy ? "Saving…" : "Save"}
					</Button>
				</div>
			)}
		</Row>
	);
}

/** The engine in use (the choice, or the default for the keys that exist) and its model list. */
function useEngineChoices(prefs: FeedPrefs, status: EngineStatus | null): { engine: EngineId | null; models: readonly ModelInfo[]; defaultModel: string | null; error: string | null } {
	const engine = prefs.engine === "auto" ? (status?.engine ?? null) : prefs.engine;
	const [state, setState] = useState<{ engine: EngineId | null; models: readonly ModelInfo[]; defaultModel: string | null; error: string | null }>({ engine: null, models: [], defaultModel: null, error: null });
	// The key flags decide what "auto" means and whether a list can be fetched at all.
	const keyed = `${status?.hasGemini ?? ""}${status?.hasGroq ?? ""}`;
	useEffect(() => {
		if (!engine) return;
		let current = true;
		void window.teez.feed.models(engine).then(
			(result) => {
				if (!current) return;
				setState(result.ok ? { engine, models: result.models, defaultModel: result.defaultModel, error: null } : { engine, models: [], defaultModel: null, error: result.error });
			},
			() => current && setState({ engine, models: [], defaultModel: null, error: "Could not load the models." }),
		);
		return () => {
			current = false;
		};
	}, [engine, keyed]);
	return state.engine === engine ? state : { engine, models: [], defaultModel: null, error: null };
}

export function FeedPage(): React.JSX.Element {
	const [sending, setSending] = useState(false);
	const sendKeys = useCallback((): void => {
		setSending(true);
		window.teez.phone.sendKeys().then(
			(result) => useUi.getState().toast(result.message, result.ok ? "info" : "error"),
			(e: unknown) => useUi.getState().toast(`Could not send the keys: ${e instanceof Error ? e.message : String(e)}`, "error"),
		).finally(() => setSending(false));
	}, []);
	const hasGroq = useFeed((s) => s.hasGroq);
	const hasGemini = useFeed((s) => s.hasGemini);
	const status = useFeed((s) => s.engine);
	const [prefs, setPrefs] = useState<FeedPrefs>(DEFAULT_FEED_PREFS);

	useEffect(() => {
		void window.teez.feed.prefs().then(setPrefs, () => undefined);
		void useFeed.getState().refreshKeys();
		void useFeed.getState().refreshEngine();
	}, []);

	const choices = useEngineChoices(prefs, status);

	const change = useCallback((next: FeedPrefs): void => {
		setPrefs(next);
		void window.teez.feed.setPrefs(next).then((saved) => {
			setPrefs(saved);
			void useFeed.getState().refreshEngine();
		});
	}, []);

	const modelOptions: readonly Option[] = [
		{ id: "", label: choices.defaultModel ? `Default (${choices.defaultModel})` : "Default" },
		...choices.models.map((m) => ({ id: m.id, label: m.label === m.id ? m.id : `${m.label} (${m.id})` })),
	];
	const engine = choices.engine;
	const chosenModel = engine ? prefs.models[engine] : "";
	const withChosen = chosenModel && !modelOptions.some((o) => o.id === chosenModel) ? [...modelOptions, { id: chosenModel, label: chosenModel }] : modelOptions;

	return (
		<>
			<Section title="Feed the Brain">
				<EnabledRow module="feed" what="Feed the Brain" extra="Turning Feed off cancels a running job; queued items wait." />
				<Row label="Engine" hint="Which model reads a source and writes the notes. It gets the text only and has no tools; TeezOS writes the notes itself.">
					<Select label="Engine" value={prefs.engine} options={ENGINE_OPTIONS} onChange={(id) => change({ ...prefs, engine: id as EngineChoice })} />
				</Row>
				<Row label="Model" hint={choices.error ?? (engine ? `Models ${ENGINE_LABEL[engine]} offers this account.` : "")}>
					<Select
						label="Model"
						value={chosenModel}
						options={withChosen}
						onChange={(id) => {
							if (engine) change({ ...prefs, models: { ...prefs.models, [engine]: id } });
						}}
					/>
				</Row>
				<KeyRow
					label="Gemini key"
					hint="A free key from aistudio.google.com. Stored encrypted on this PC; never shown again."
					placeholder="AIza…"
					has={hasGemini}
					looksValid={(key) => key.length >= 20 && key.length <= MAX_GEMINI_KEY && /^[\x21-\x7e]+$/.test(key)}
					maxLength={MAX_GEMINI_KEY}
					onSave={(key) => useFeed.getState().setGemini(key)}
				/>
				<KeyRow
					label="Groq key"
					hint="Reads sources as an engine, and transcribes videos without subtitles. Stored encrypted on this PC; never shown again."
					placeholder="gsk_…"
					has={hasGroq}
					looksValid={(key) => key.startsWith("gsk_")}
					maxLength={200}
					onSave={(key) => useFeed.getState().setGroq(key)}
				/>
				<Row label="Phone server" hint="Copies the saved Gemini and Groq keys to the phone service over SSH (host pve). They are never shown here.">
					<Button disabled={sending || (!hasGemini && !hasGroq)} onClick={sendKeys}>
						Send keys to the phone server
					</Button>
				</Row>
			</Section>
			<Section title="Output folders">
				<Note>
					The source note goes to reference/sources/, its concepts to brain/concepts/ (created, or appended to with a link back) and skill drafts to
					thinking/skill-drafts/ in the vault. Everything else in the vault is read-only to the feed, so these are fixed. Gemini and Groq are reached
					only at generativelanguage.googleapis.com and api.groq.com.
				</Note>
			</Section>
		</>
	);
}
