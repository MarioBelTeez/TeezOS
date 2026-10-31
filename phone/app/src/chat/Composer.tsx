import type { ReactNode, RefObject } from "react";
import { AGY_EFFORT_OPTIONS, CLAUDE_EFFORT_OPTIONS } from "../../../../src/shared/effort.ts";
import type { Engine } from "../chat-stream.ts";

/**
 * The composer, docked above the keyboard. Voice input is the iOS keyboard's
 * own dictation: there is no recorder here. The engine and effort pickers sit
 * underneath; they set up a new chat and are fixed once a chat has messages
 * (the server keeps a chat's engine for its whole life).
 */

export const DEFAULT_EFFORT: Readonly<Record<Engine, string>> = { agy: "medium", claude: "" };
const MAX_ROWS = 6;

type Props = {
	inputRef: RefObject<HTMLTextAreaElement | null>;
	text: string;
	onText: (text: string) => void;
	onSend: () => void;
	onStop: () => void;
	sending: boolean;
	running: boolean;
	engine: Engine;
	effort: string;
	onEngine: (engine: Engine) => void;
	onEffort: (effort: string) => void;
	locked: boolean;
	claudeBlocked: string | null;
};

export function Composer(props: Props): ReactNode {
	const { text, running, sending, engine, effort, locked, claudeBlocked } = props;
	const rows = Math.min(MAX_ROWS, Math.max(1, text.split("\n").length));
	const efforts = engine === "claude" ? CLAUDE_EFFORT_OPTIONS : AGY_EFFORT_OPTIONS;
	const canSend = text.trim() !== "" && !sending;
	return (
		<div className="composer-dock safe-x glass shrink-0 border-t border-border pt-2 pb-2">
			<form
				className="flex items-end gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (canSend) props.onSend();
				}}
			>
				<textarea
					ref={props.inputRef}
					className="input max-h-48 min-h-11 flex-1 resize-none"
					rows={rows}
					value={text}
					placeholder="Ask TeezOS…"
					enterKeyHint="send"
					autoFocus
					aria-label="Message"
					onChange={(event) => props.onText(event.target.value)}
				/>
				{running ? (
					<button type="button" onClick={props.onStop} className="h-11 min-w-16 border border-red px-3 font-display text-[20px] tracking-wider text-red-hot active:bg-red/20">
						Stop
					</button>
				) : null}
				<button type="submit" disabled={!canSend} className="btn-hot h-11 min-w-16 px-3 font-display text-[20px] tracking-wider">
					{sending ? "…" : "Send"}
				</button>
			</form>
			<div className="mt-2 flex items-center gap-2">
				<select
					aria-label="Engine"
					className="input w-auto! py-1.5! text-[16px]!"
					value={engine}
					disabled={locked}
					onChange={(event) => props.onEngine(event.target.value === "claude" ? "claude" : "agy")}
				>
					<option value="agy">Antigravity</option>
					<option value="claude" disabled={claudeBlocked !== null}>
						Claude{claudeBlocked ? " (needs a token)" : ""}
					</option>
				</select>
				<select aria-label="Effort" className="input w-auto! py-1.5! text-[16px]!" value={effort} disabled={locked} onChange={(event) => props.onEffort(event.target.value)}>
					{efforts.map((option) => (
						<option key={option.id} value={option.id}>
							{option.label}
						</option>
					))}
				</select>
				{locked ? <span className="truncate text-[14px] text-muted">New chat to change</span> : null}
			</div>
			{claudeBlocked ? <p className="mt-1 text-[14px] text-amber">{claudeBlocked}</p> : null}
		</div>
	);
}
