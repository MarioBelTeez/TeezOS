import { useState } from "react";
import { HelpCircle, Send } from "lucide-react";

export type NormalizedOption = {
	readonly label: string;
	readonly description?: string | undefined;
};

export type NormalizedQuestion = {
	readonly question: string;
	readonly header?: string | undefined;
	readonly multiSelect: boolean;
	readonly options: readonly NormalizedOption[];
};

/** Parses either Claude's `AskUserQuestion` or Antigravity's `ask_question` input shape. */
export function parseQuestionInput(input: Readonly<Record<string, unknown>>): readonly NormalizedQuestion[] {
	const raw = input["questions"];
	if (!Array.isArray(raw)) return [];
	const questions: NormalizedQuestion[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const rec = item as Record<string, unknown>;
		const question = typeof rec["question"] === "string" ? rec["question"].trim() : "";
		if (!question) continue;
		const header = typeof rec["header"] === "string" ? rec["header"].trim() : undefined;
		const multiSelect = rec["multiSelect"] === true || rec["is_multi_select"] === true;
		const options: NormalizedOption[] = [];
		if (Array.isArray(rec["options"])) {
			for (const opt of rec["options"]) {
				if (typeof opt === "string") {
					if (opt.trim()) options.push({ label: opt.trim() });
				} else if (typeof opt === "object" && opt !== null) {
					const optRec = opt as Record<string, unknown>;
					const label = typeof optRec["label"] === "string" ? optRec["label"].trim() : "";
					const description = typeof optRec["description"] === "string" ? optRec["description"].trim() : undefined;
					if (label) options.push({ label, description });
				}
			}
		}
		questions.push({ question, header, multiSelect, options });
	}
	return questions;
}

export function QuestionCard({
	questions,
	agentName,
	settledText,
	onSubmit,
	onSkip,
}: {
	readonly questions: readonly NormalizedQuestion[];
	readonly agentName: string;
	readonly settledText?: string | undefined;
	readonly onSubmit: (answers: Record<string, string>) => void;
	readonly onSkip?: (() => void) | undefined;
}): React.JSX.Element {
	const [selected, setSelected] = useState<Record<number, string[]>>({});
	const [custom, setCustom] = useState<Record<number, string>>({});
	const [showCustom, setShowCustom] = useState<Record<number, boolean>>({});
	const [submitted, setSubmitted] = useState(false);

	const isSingleInstant = questions.length === 1 && !questions[0]!.multiSelect;
	const disabled = submitted || Boolean(settledText);

	const toggleOption = (qIndex: number, label: string, multi: boolean): void => {
		if (disabled) return;
		if (isSingleInstant && !multi) {
			setSelected({ [qIndex]: [label] });
			setSubmitted(true);
			onSubmit({ [questions[qIndex]!.question]: label });
			return;
		}
		setSelected((prev) => {
			const current = prev[qIndex] ?? [];
			if (!multi) return { ...prev, [qIndex]: [label] };
			return {
				...prev,
				[qIndex]: current.includes(label) ? current.filter((x) => x !== label) : [...current, label],
			};
		});
	};

	const buildAnswers = (): Record<string, string> => {
		const answers: Record<string, string> = {};
		questions.forEach((q, idx) => {
			const picked = selected[idx] ?? [];
			const typed = (custom[idx] ?? "").trim();
			const combined = typed ? [...picked, typed] : picked;
			if (combined.length > 0) answers[q.question] = combined.join(", ");
		});
		return answers;
	};

	const hasAnyAnswer = questions.some((_, idx) => (selected[idx]?.length ?? 0) > 0 || (custom[idx]?.trim().length ?? 0) > 0);

	const submitAll = (): void => {
		if (disabled || !hasAnyAnswer) return;
		const answers = buildAnswers();
		setSubmitted(true);
		onSubmit(answers);
	};

	return (
		<div className="cut-corner bg-surface p-3 ring-1 ring-red/40">
			<p className="flex items-center gap-2 font-condensed text-xs uppercase tracking-wider text-red">
				<HelpCircle size={14} />
				{agentName} asks
			</p>
			<div className="mt-2.5 space-y-3">
				{questions.map((q, qIdx) => {
					const current = selected[qIdx] ?? [];
					const customOpen = showCustom[qIdx] ?? false;
					return (
						<div key={q.question} className="space-y-1.5">
							{q.header ? <p className="font-mono text-[10px] uppercase tracking-wider text-muted">{q.header}</p> : null}
							<p className="text-[length:var(--chat-text)] font-medium text-text">{q.question}</p>
							<div className="flex flex-col gap-1.5 pt-0.5">
								{q.options.map((opt) => {
									const active = current.includes(opt.label);
									return (
										<button
											key={opt.label}
											type="button"
											disabled={disabled}
											onClick={() => toggleOption(qIdx, opt.label, q.multiSelect)}
											className={`flex flex-col items-start rounded-md px-3 py-2 text-left transition-colors ring-1 ${
												active
													? "bg-red/20 text-text ring-red"
													: "bg-bg/70 text-text ring-border hover:bg-red/10 hover:ring-red/50"
											} disabled:opacity-55`}
										>
											<span className="text-[length:var(--chat-text)] font-medium">{opt.label}</span>
											{opt.description ? <span className="text-[12px] text-muted">{opt.description}</span> : null}
										</button>
									);
								})}
								{!customOpen ? (
									<button
										type="button"
										disabled={disabled}
										onClick={() => setShowCustom((prev) => ({ ...prev, [qIdx]: true }))}
										className="self-start rounded-md px-3 py-1.5 font-condensed text-xs uppercase tracking-wider text-muted ring-1 ring-border hover:text-text hover:ring-red/40 disabled:opacity-50"
									>
										+ Add your own…
									</button>
								) : (
									<div className="flex gap-1.5 pt-0.5">
										<input
											type="text"
											disabled={disabled}
											value={custom[qIdx] ?? ""}
											placeholder="Type your answer…"
											onChange={(e) => setCustom((prev) => ({ ...prev, [qIdx]: e.target.value }))}
											onKeyDown={(e) => {
												if (e.key === "Enter" && isSingleInstant && (custom[qIdx] ?? "").trim()) {
													e.preventDefault();
													submitAll();
												}
											}}
											className="input flex-1 text-sm"
											autoFocus
										/>
										{isSingleInstant ? (
											<button
												type="button"
												disabled={disabled || !(custom[qIdx] ?? "").trim()}
												onClick={submitAll}
												className="cut-corner flex items-center gap-1 bg-red px-3 py-1 font-condensed text-xs uppercase tracking-wider disabled:opacity-40"
											>
												<Send size={12} />
												Send
											</button>
										) : null}
									</div>
								)}
							</div>
						</div>
					);
				})}
			</div>
			{settledText ? (
				<p className="mt-2 font-mono text-[length:var(--chat-meta)] text-muted">{settledText}</p>
			) : !isSingleInstant || onSkip ? (
				<div className="mt-3 flex items-center gap-2">
					{!isSingleInstant ? (
						<button
							type="button"
							disabled={disabled || !hasAnyAnswer}
							onClick={submitAll}
							className="cut-corner bg-red px-4 py-1 font-condensed text-xs uppercase tracking-wider disabled:opacity-40"
						>
							Submit
						</button>
					) : null}
					{onSkip ? (
						<button
							type="button"
							disabled={disabled}
							onClick={onSkip}
							className="cut-corner px-3 py-1 font-condensed text-xs uppercase tracking-wider text-muted ring-1 ring-border hover:text-text"
						>
							Dismiss
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
}
