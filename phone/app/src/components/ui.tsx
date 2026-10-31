import type { ReactNode } from "react";
import type { PullState } from "./hooks.ts";

/** The small shared pieces every screen uses, in the TeezOS look. */

export function ScreenHeader({ title, left, right }: { title: string; left?: ReactNode; right?: ReactNode }): ReactNode {
	return (
		<header className="safe-top safe-x glass flex shrink-0 items-center gap-2 border-b border-border pb-2">
			<div className="flex min-w-11 items-center">{left}</div>
			<h1 className="font-display glow-text flex-1 truncate text-center text-[28px] leading-none tracking-wider">{title}</h1>
			<div className="flex min-w-11 items-center justify-end">{right}</div>
		</header>
	);
}

export function SectionTitle({ children }: { children: ReactNode }): ReactNode {
	return <h2 className="font-display mt-5 mb-2 text-[20px] tracking-wider text-muted">{children}</h2>;
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }): ReactNode {
	return <div className={`cut-corner border border-border bg-surface p-3 ${className}`}>{children}</div>;
}

export function ErrorLine({ text, offline }: { text: string; offline?: boolean }): ReactNode {
	return (
		<p role="alert" className={`my-2 border-l-2 px-3 py-2 text-[16px] ${offline ? "border-amber text-amber" : "border-red-hot text-[#ff8da0]"}`}>
			{text}
		</p>
	);
}

type Tone = "ok" | "warn" | "bad" | "idle" | "live";
const DOT: Readonly<Record<Tone, string>> = {
	ok: "bg-ok",
	warn: "bg-amber",
	bad: "bg-red-hot",
	idle: "bg-muted",
	live: "bg-red-hot pulse-dot",
};

export function Dot({ tone }: { tone: Tone }): ReactNode {
	return <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[tone]}`} />;
}

export function IconButton({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }): ReactNode {
	return (
		<button
			type="button"
			aria-label={label}
			disabled={disabled}
			onClick={onClick}
			className="flex h-11 min-w-11 items-center justify-center px-2 text-[16px] text-text active:text-red-hot disabled:opacity-40"
		>
			{children}
		</button>
	);
}

/** A sheet that rises from the bottom, over a dimmed screen. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactNode {
	return (
		<div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={onClose}>
			<div
				role="dialog"
				aria-label={title}
				className="safe-bottom glass max-h-[85%] overflow-hidden border-t border-red/60"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="safe-x flex items-center justify-between py-2">
					<h2 className="font-display text-[22px] tracking-wider">{title}</h2>
					<IconButton label="Close" onClick={onClose}>
						Close
					</IconButton>
				</div>
				<div className="scroll-y safe-x max-h-[70vh] pb-4">{children}</div>
			</div>
		</div>
	);
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
	return <p className="py-8 text-center text-[16px] text-muted">{children}</p>;
}

export function PullHint({ state }: { state: PullState }): ReactNode {
	if (state === "idle") return null;
	const text = state === "pulling" ? "Pull to refresh" : state === "ready" ? "Release to refresh" : "Refreshing…";
	return <p className="py-2 text-center font-mono text-[13px] text-muted">{text}</p>;
}
