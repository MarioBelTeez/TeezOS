import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeMarkdownUrl } from "../../shared/safe-url.ts";
import { AlertTriangle, Check, CircleDot, Loader2, ShieldAlert, X } from "lucide-react";
import type { Card, ToolStep } from "./reduce.ts";
import { summarize } from "./summarize.ts";
import { needsLogin } from "./agent-options.ts";
import { browserEnabled, openInBrowser } from "../browser/open.ts";

/**
 * How each card looks. Replies render as markdown (tables, code, links);
 * edits show what changed; anything the agent wants permission for is framed
 * in red with the two buttons where the eye already is.
 */

/**
 * Text as it really is: control characters and bidirectional overrides —
 * which can make a command read differently from what runs — shown as codes.
 */
export function revealHidden(text: string): string {
	return text
		.replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, (c) => `⟦U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟧`)
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (c) => `⟦\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}⟧`);
}

/** Every field of a tool's input, in full — what an approval actually approves. */
function FullInput({ input }: { readonly input: Readonly<Record<string, unknown>> }): React.JSX.Element {
	const entries = Object.entries(input).filter(([key]) => key !== "old_string" && key !== "new_string" && key !== "content");
	return (
		<dl className="mt-2 max-h-72 space-y-1.5 overflow-auto bg-bg p-2 ring-1 ring-border">
			{entries.map(([key, value]) => (
				<div key={key}>
					<dt className="font-mono text-[length:var(--chat-meta)] uppercase tracking-wider text-muted">{key}</dt>
					<dd className="font-mono text-[length:var(--chat-code)] whitespace-pre-wrap break-all text-text">
						{revealHidden(typeof value === "string" ? value : JSON.stringify(value, null, 2))}
					</dd>
				</div>
			))}
		</dl>
	);
}

/**
 * A web link from an answer opens in the Browser panel when it is on.
 * Shift+click is left to the window, which sends it to the system browser
 * (src/main/index.ts); so are links when the browser module is off.
 */
function openLink(event: React.MouseEvent<HTMLAnchorElement>, href: string | undefined): void {
	if (!href || !/^https?:\/\//i.test(href) || href.length > 2048) return;
	if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
	if (!browserEnabled()) return;
	event.preventDefault();
	openInBrowser(href);
}

export const MarkdownText = memo(function MarkdownText({ text }: { readonly text: string }) {
	return (
		<div className="prose-teez">
			<Markdown
				remarkPlugins={[remarkGfm]}
				urlTransform={safeMarkdownUrl}
				components={{
					a: ({ href, children }) => (
						<a href={href} target="_blank" rel="noreferrer" onClick={(event) => openLink(event, href)}>
							{children}
						</a>
					),
				}}
			>
				{text}
			</Markdown>
		</div>
	);
});

/** Edit and Write calls carry the change itself; show it as a diff. */
function EditPreview({ input }: { readonly input: Readonly<Record<string, unknown>> }): React.JSX.Element | null {
	const oldText = typeof input["old_string"] === "string" ? input["old_string"] : null;
	const newText = typeof input["new_string"] === "string" ? input["new_string"] : null;
	const content = typeof input["content"] === "string" ? input["content"] : null;
	if (oldText === null && newText === null && content === null) return null;

	const lines: { readonly sign: "-" | "+"; readonly text: string }[] = [];
	if (oldText !== null) for (const line of oldText.split("\n")) lines.push({ sign: "-", text: line });
	if (newText !== null) for (const line of newText.split("\n")) lines.push({ sign: "+", text: line });
	if (content !== null) for (const line of content.split("\n").slice(0, 60)) lines.push({ sign: "+", text: line });

	return (
		<pre className="max-h-72 overflow-auto border-t border-border font-mono text-[length:var(--chat-code)] leading-[1.55]">
			{lines.map((line, index) => (
				<div
					// eslint-disable-next-line react/no-array-index-key
					key={index}
					className={line.sign === "-" ? "bg-red/10 text-[#ff9aa9]" : "bg-[#22c55e]/10 text-[#9be3b4]"}
				>
					<span className="inline-block w-5 select-none pl-1 opacity-60">{line.sign}</span>
					{line.text}
				</div>
			))}
		</pre>
	);
}

function StatusIcon({ status }: { readonly status: ToolStep["status"] }): React.JSX.Element {
	if (status === "running") return <Loader2 size={12} className="shrink-0 animate-spin text-[#f5a524]" />;
	if (status === "failed") return <X size={12} className="shrink-0 text-red" />;
	return <Check size={12} className="shrink-0 text-[#22c55e]" />;
}

/** What an Agent card's subagent did: its calls one line each, then what it said. */
function SubagentSteps({ summary, steps }: { readonly summary: string; readonly steps: readonly ToolStep[] }): React.JSX.Element {
	return (
		<div className="border-t border-border px-3 py-2">
			{steps.length > 0 ? (
				<ol className="max-h-64 space-y-0.5 overflow-auto font-mono text-[length:var(--chat-tool)] text-muted">
					{steps.map((step) => (
						<li key={step.toolUseId} className="flex items-center gap-2" title={step.result.slice(0, 2000)}>
							<StatusIcon status={step.status} />
							<span className="shrink-0 text-text">{step.name}</span>
							<span className="min-w-0 truncate">{summarize(step.input)}</span>
						</li>
					))}
				</ol>
			) : null}
			{summary ? (
				<p className={`max-h-40 overflow-auto text-[length:var(--chat-tool)] whitespace-pre-wrap text-muted ${steps.length > 0 ? "mt-2" : ""}`}>
					{summary}
				</p>
			) : null}
		</div>
	);
}

export type CardActions = {
	readonly onApprove: (requestId: string, decision: "allow" | "deny") => void;
	readonly onOpenFile: (path: string) => void;
	readonly onRetry: () => void;
	readonly onLogin: () => void;
};

export const CardView = memo(function CardView({
	card,
	agentName,
	actions,
	streaming = false,
}: {
	readonly card: Card;
	readonly agentName: string;
	readonly actions: CardActions;
	/** The reply still being written: it ends in a glowing caret. */
	readonly streaming?: boolean;
}): React.JSX.Element | null {
	const { onApprove, onOpenFile } = actions;
	switch (card.kind) {
		case "user":
			return (
				<div className="ml-auto w-fit max-w-[88%] cut-corner bg-red/15 px-3 py-2 text-[length:var(--chat-text)] whitespace-pre-wrap ring-1 ring-red/30">
					{card.images && card.images.length > 0 ? (
						<div className={`flex flex-wrap gap-1.5 ${card.text ? "mb-2" : ""}`}>
							{card.images.map((src, index) => (
								<img key={index} src={src} alt="" className="max-h-40 max-w-full object-contain ring-1 ring-border" />
							))}
						</div>
					) : null}
					{card.text}
				</div>
			);

		case "assistant":
			return streaming ? (
				<div className="stream-caret">
					<MarkdownText text={card.text} />
				</div>
			) : (
				<MarkdownText text={card.text} />
			);

		case "tool": {
			const path = typeof card.input["file_path"] === "string" ? card.input["file_path"] : null;
			const isEdit = /^(Edit|MultiEdit|Write|replace_file_content|write_to_file|multi_replace_file_content)$/.test(card.name);
			return (
				<details className="group/tool bg-surface ring-1 ring-border">
					<summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 font-mono text-[length:var(--chat-tool)] text-muted marker:content-none">
						<StatusIcon status={card.status} />
						<span className="shrink-0 text-text">{card.name}</span>
						<span className="min-w-0 truncate">{summarize(card.input)}</span>
						{card.steps && card.steps.length > 0 ? (
							<span className="shrink-0 opacity-70">
								· {card.steps.length} {card.steps.length === 1 ? "step" : "steps"}
							</span>
						) : null}
						{path ? (
							<button
								type="button"
								onClick={(event) => {
									event.preventDefault();
									onOpenFile(path);
								}}
								className="ml-auto shrink-0 text-[length:var(--chat-meta)] text-muted hover:text-red"
							>
								open
							</button>
						) : null}
					</summary>
					{isEdit ? <EditPreview input={card.input} /> : null}
					{card.summary || (card.steps && card.steps.length > 0) ? <SubagentSteps summary={card.summary ?? ""} steps={card.steps ?? []} /> : null}
					{card.result ? (
						<pre className="max-h-64 overflow-auto border-t border-border px-3 py-2 font-mono text-[length:var(--chat-code)] whitespace-pre-wrap text-muted">
							{card.result.length > 20000 ? `${card.result.slice(0, 20000)}\n…` : card.result}
						</pre>
					) : null}
				</details>
			);
		}

		case "approval":
			return (
				<div className="cut-corner bg-surface p-3 ring-1 ring-red/50">
					<p className="flex items-center gap-2 font-condensed text-sm uppercase tracking-wider">
						<ShieldAlert size={15} className="text-red" />
						{agentName} wants to run <span className="text-red">{card.toolName}</span>
					</p>
					<FullInput input={card.input} />
					<EditPreview input={card.input} />
					{card.decision === "pending" ? (
						<div className="mt-3 flex gap-2">
							<button
								type="button"
								onClick={() => onApprove(card.requestId, "allow")}
								className="cut-corner bg-red px-4 py-1 font-condensed text-xs uppercase tracking-wider"
							>
								Approve
							</button>
							<button
								type="button"
								onClick={() => onApprove(card.requestId, "deny")}
								className="cut-corner px-4 py-1 font-condensed text-xs uppercase tracking-wider text-muted ring-1 ring-border hover:text-text"
							>
								Deny
							</button>
						</div>
					) : (
						<p className="mt-2 font-mono text-[length:var(--chat-meta)] text-muted">
							{card.decision === "allow" ? "approved" : card.decision === "deny" ? "denied" : "expired — the run ended first"}
						</p>
					)}
				</div>
			);

		case "cancelled":
			// You asked it to stop; that is not a failure, so it does not get
			// the red treatment.
			return <p className="font-mono text-[length:var(--chat-meta)] text-muted">stopped · {(card.durationMs / 1000).toFixed(1)}s</p>;

		case "error":
			return <ErrorCard reason={card.reason} text={card.text} actions={actions} />;

		case "turn":
			return (
				<p className="flex items-center gap-1.5 font-mono text-[length:var(--chat-meta)] text-muted">
					<CircleDot size={9} />
					{(card.durationMs / 1000).toFixed(1)}s
					{card.costUsd > 0 ? ` · $${card.costUsd.toFixed(4)}` : ""}
				</p>
			);

		case "notice":
			return <p className="text-center font-mono text-[length:var(--chat-meta)] text-muted">— {card.text} —</p>;

		default:
			return null;
	}
});

/** What an error means and what to do, rather than just its code. */
const HELP: Readonly<Record<string, string>> = {
	"claude-not-found": "Claude Code is not installed where TeezOS looks. Install it, or open the terminal and run `claude` once.",
	"agy-not-found": "Antigravity's CLI was not found. Install it from antigravity.google, then reopen TeezOS.",
	"codex-not-found": "Codex isn't installed where TeezOS looks. Install it with `npm i -g @openai/codex`, run `codex login` once, then reopen TeezOS.",
	"codex-logged-out": "Codex isn't logged in. Open the terminal, run `codex login` and sign in with your ChatGPT account.",
	"codex-unsupported": "This Codex version isn't supported yet. TeezOS works with Codex 0.166.x. Update TeezOS, or install that Codex version (`npm i -g @openai/codex@0.166`).",
	"codex-start": "Codex couldn't start this chat. If you haven't yet, run `codex login` in the terminal, then send the message again.",
	"codex-exited": "Codex stopped unexpectedly. Send your message again to continue the same conversation.",
	authentication_failed: "Claude Code is logged out. Open the terminal (Ctrl+`) and run `claude` to log in.",
	billing_error: "The account has a billing problem. Check it in claude.ai, then retry.",
	rate_limit: "The usage limit was reached. It resets on its own; the meter shows when.",
	overloaded: "The service is overloaded right now. Retry in a minute.",
	error_max_turns: "The run hit its turn limit before finishing. Ask it to continue.",
};

function ErrorCard({
	reason,
	text,
	actions,
}: {
	readonly reason: string;
	readonly text: string;
	readonly actions: CardActions;
}): React.JSX.Element {
	const help = HELP[reason] ?? Object.entries(HELP).find(([key]) => text.includes(key))?.[1];
	const login = needsLogin(reason, text);
	const canRetry = reason !== "agy-denied" && reason !== "claude-not-found" && reason !== "agy-not-found";
	return (
		<div className="cut-corner bg-red/10 px-3 py-2 text-[length:var(--chat-text)] ring-1 ring-red/40">
			<p className="flex items-center gap-2 font-condensed text-xs uppercase tracking-wider text-red">
				<AlertTriangle size={13} />
				{reason.replace(/[_-]/g, " ")}
			</p>
			{help ? <p className="mt-1">{help}</p> : null}
			<pre className="mt-1 max-h-40 overflow-auto font-mono text-[length:var(--chat-code)] whitespace-pre-wrap text-muted">{text}</pre>
			<div className="mt-2 flex gap-2">
				{login ? (
					<button type="button" onClick={actions.onLogin} className="cut-corner bg-red px-3 py-0.5 font-condensed text-[11px] uppercase tracking-wider">
						Log in
					</button>
				) : null}
				{canRetry ? (
					<button
						type="button"
						onClick={actions.onRetry}
						className="cut-corner px-3 py-0.5 font-condensed text-[11px] uppercase tracking-wider ring-1 ring-border hover:ring-red/50"
					>
						Retry
					</button>
				) : null}
			</div>
		</div>
	);
}
