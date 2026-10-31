import { useEffect, useRef, useState } from "react";
import type { ModuleId } from "../../../shared/modules.ts";
import { unhideModuleViews } from "../../../shared/views.ts";
import { useSettings } from "../../state/settings.ts";

/** The building blocks every Settings page is made of. */

export type Option = { readonly id: string; readonly label: string };

export function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }): React.JSX.Element {
	return (
		<section className="mt-8 first:mt-2">
			<h2 className="mb-3 flex max-w-3xl items-center gap-3 font-display text-[22px] leading-none tracking-[0.08em] text-text">
				<span className="h-4 w-[3px] -skew-x-12 bg-red-hot shadow-[0_0_10px_var(--color-glow)]" />
				<span className="glow-text">{title.toUpperCase()}</span>
				<span className="h-px flex-1 bg-linear-to-r from-red/50 to-transparent" />
			</h2>
			{children}
		</section>
	);
}

export function Row({ label, hint, children }: { readonly label: string; readonly hint?: string | undefined; readonly children: React.ReactNode }): React.JSX.Element {
	return (
		<div className="flex max-w-3xl items-center gap-6 border-b border-border/60 py-2.5">
			<div className="w-64 shrink-0">
				<p className="text-[14px]">{label}</p>
				{hint ? <p className="font-mono text-[10px] text-muted">{hint}</p> : null}
			</div>
			{children}
		</div>
	);
}

export function Select({
	value,
	options,
	onChange,
	label,
}: {
	readonly value: string;
	readonly options: readonly (Option & { readonly disabled?: boolean })[];
	readonly onChange: (id: string) => void;
	readonly label?: string | undefined;
}): React.JSX.Element {
	return (
		<select
			value={value}
			aria-label={label}
			onChange={(event) => onChange(event.target.value)}
			className="min-w-56 bg-surface px-2 py-1 font-mono text-[12px] text-text outline-none ring-1 ring-border focus:glow"
		>
			{options.map((option) => (
				<option key={option.id} value={option.id} disabled={option.disabled}>
					{option.label}
				</option>
			))}
		</select>
	);
}

export function Segmented({
	value,
	options,
	onChange,
}: {
	readonly value: string;
	readonly options: readonly Option[];
	readonly onChange: (id: string) => void;
}): React.JSX.Element {
	return (
		<div className="flex ring-1 ring-border" role="radiogroup">
			{options.map((option) => (
				<button
					key={option.id}
					type="button"
					role="radio"
					aria-checked={value === option.id}
					onClick={() => onChange(option.id)}
					className={`px-3 py-1 font-condensed text-[12px] uppercase tracking-wider transition-colors ${
						value === option.id ? "bg-red text-text shadow-[0_0_12px_var(--color-glow)]" : "text-muted hover:text-text"
					}`}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export function Toggle({ value, onChange, label }: { readonly value: boolean; readonly onChange: (value: boolean) => void; readonly label?: string }): React.JSX.Element {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={value}
			aria-label={label}
			onClick={() => onChange(!value)}
			className={`relative h-5 w-10 shrink-0 ring-1 transition-colors ${value ? "bg-red/80 ring-red-hot shadow-[0_0_12px_var(--color-glow)]" : "bg-surface ring-border hover:ring-red/50"}`}
		>
			<span className={`absolute top-0.5 h-4 w-4 -skew-x-12 transition-[left] ${value ? "left-[22px] bg-text" : "left-0.5 bg-muted"}`} />
		</button>
	);
}

/** Commits a dragged slider at most this often, so the settings file is not rewritten every frame. */
const COMMIT_MS = 150;

/** A slider with the number beside it; typing a number works too. Out-of-range input is clamped. */
export function NumberField({
	value,
	min,
	max,
	step,
	onChange,
	label,
	unit,
}: {
	readonly value: number;
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly onChange: (value: number) => void;
	readonly label?: string | undefined;
	readonly unit?: string | undefined;
}): React.JSX.Element {
	const [draft, setDraft] = useState(String(value));
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latest = useRef(onChange);
	latest.current = onChange;
	/** While a slider is held or the number is being typed, the saved value arriving back does not move it. */
	const editing = useRef(false);

	useEffect(() => {
		if (!editing.current) setDraft(String(value));
	}, [value]);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	const clampTo = (raw: number): number => {
		const stepped = Math.round((raw - min) / step) * step + min;
		return Math.min(max, Math.max(min, Number(stepped.toFixed(4))));
	};
	const commit = (raw: number, now: boolean): void => {
		if (!Number.isFinite(raw)) {
			setDraft(String(value));
			return;
		}
		const next = clampTo(raw);
		setDraft(String(next));
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		if (now) {
			if (next !== value) latest.current(next);
			return;
		}
		timer.current = setTimeout(() => {
			timer.current = null;
			latest.current(next);
		}, COMMIT_MS);
	};

	return (
		<div className="flex items-center gap-3">
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={Number(draft) || min}
				aria-label={label}
				onPointerDown={() => {
					editing.current = true;
					// Released anywhere (outside the slider too), or the pointer taken away: editing ends.
					const release = (): void => {
						editing.current = false;
						window.removeEventListener("pointerup", release, true);
						window.removeEventListener("pointercancel", release, true);
					};
					window.addEventListener("pointerup", release, true);
					window.addEventListener("pointercancel", release, true);
				}}
				onLostPointerCapture={() => (editing.current = false)}
				onChange={(event) => commit(Number(event.target.value), false)}
				className="w-44 accent-[#e8002d]"
			/>
			<input
				type="number"
				min={min}
				max={max}
				step={step}
				value={draft}
				aria-label={label ? `${label} value` : undefined}
				onFocus={() => (editing.current = true)}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					editing.current = false;
					commit(Number(draft), true);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") commit(Number(draft), true);
				}}
				className="w-20 bg-surface px-2 py-1 font-mono text-[12px] text-text outline-none ring-1 ring-border focus:glow"
			/>
			{unit ? <span className="font-mono text-[10.5px] text-muted">{unit}</span> : null}
		</div>
	);
}

/** A module page's first row: off takes it out of the left bar and the panel menu and closes its panels. */
export function EnabledRow({
	module,
	what,
	extra,
}: {
	readonly module: Exclude<ModuleId, "chat" | "editor">;
	readonly what: string;
	/** More to say about turning it off, after the common hint. */
	readonly extra?: string;
}): React.JSX.Element | null {
	const enabled = useSettings((s) => s.settings?.modules[module].enabled ?? true);
	const setModules = useSettings((s) => s.setModules);
	const toggle = (on: boolean): void => {
		setModules({ [module]: { enabled: on } });
		// On again: its view returns to the left bar even if it was hidden there before.
		const hidden = useSettings.getState().settings?.layout.hiddenViews ?? [];
		const shown = unhideModuleViews(hidden, module);
		if (on && shown.length !== hidden.length) useSettings.getState().setLayout({ hiddenViews: shown });
	};
	return (
		<Row label="Enabled" hint={`Off: ${what} leaves the left bar and the panels menu, and its panels close on every desk.${extra ? ` ${extra}` : ""}`}>
			<Toggle value={enabled} label="Enabled" onChange={toggle} />
			<span className={`font-mono text-[11px] ${enabled ? "text-[#73c991]" : "text-muted"}`}>{enabled ? "on" : "off"}</span>
		</Row>
	);
}

export function Button({
	children,
	onClick,
	tone = "plain",
	disabled = false,
	title,
}: {
	readonly children: React.ReactNode;
	readonly onClick: () => void;
	readonly tone?: "plain" | "hot" | "danger";
	readonly disabled?: boolean;
	readonly title?: string | undefined;
}): React.JSX.Element {
	const look =
		tone === "hot"
			? "btn-hot text-white"
			: tone === "danger"
				? "bg-surface ring-1 ring-border hover:text-red hover:ring-red/60"
				: "bg-surface ring-1 ring-border hover:ring-red/50";
	return (
		<button
			type="button"
			title={title}
			disabled={disabled}
			onClick={onClick}
			className={`cut-corner px-3 py-1 font-condensed text-[11px] uppercase tracking-wider transition-shadow disabled:opacity-40 ${look}`}
		>
			{children}
		</button>
	);
}

export function Note({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
	return <p className="max-w-3xl py-2 font-mono text-[11px] leading-relaxed text-muted">{children}</p>;
}
