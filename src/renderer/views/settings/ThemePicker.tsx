import { THEMES, type Theme, type ThemeId } from "../../../shared/themes.ts";

/**
 * A card per theme, each painted in that theme's own colours (not the current
 * one), so you can see what you would get before picking it. Applies at once.
 */
export function ThemePicker({ value, onChange }: { readonly value: ThemeId; readonly onChange: (id: ThemeId) => void }): React.JSX.Element {
	return (
		<div role="radiogroup" aria-label="Theme" className="grid max-w-3xl grid-cols-2 gap-3 py-3 lg:grid-cols-3">
			{THEMES.map((theme) => (
				<ThemeCard key={theme.id} theme={theme} selected={theme.id === value} onPick={() => onChange(theme.id)} />
			))}
		</div>
	);
}

function ThemeCard({ theme, selected, onPick }: { readonly theme: Theme; readonly selected: boolean; readonly onPick: () => void }): React.JSX.Element {
	const t = theme.tokens;
	return (
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			onClick={onPick}
			className="cut-corner group flex flex-col gap-2 p-3 text-left transition-shadow"
			style={{
				background: t.bg,
				// Inset: cut-corner clips the card, which would hide an outer ring.
				boxShadow: selected ? `inset 0 0 0 2px ${t.red}, inset 0 0 22px rgb(${t.redRgb} / 0.28)` : `inset 0 0 0 1px ${t.border}`,
			}}
		>
			{/* A tiny mock of the app: a surface panel, a bar at ~60 %, an accent button. */}
			<div className="flex h-14 gap-1.5 p-1.5" style={{ background: t.surface, border: `1px solid ${t.border}` }} aria-hidden>
				<div className="flex flex-1 flex-col justify-between">
					<div className="h-1.5 w-3/4" style={{ background: t.muted, opacity: 0.5 }} />
					<div className="h-1 w-full" style={{ background: t.border }}>
						<div className="h-full w-3/5" style={{ background: t.red }} />
					</div>
				</div>
				<div className="flex w-10 items-center justify-center self-end py-0.5 font-condensed text-[9px] font-bold uppercase" style={{ background: t.red, color: t.onRed }}>
					Go
				</div>
			</div>
			<div>
				<p className="font-condensed text-[13px] font-semibold uppercase tracking-wider" style={{ color: t.text }}>
					{theme.name}
					{selected ? <span style={{ color: t.red }}> · on</span> : null}
				</p>
				<p className="truncate font-mono text-[10px]" style={{ color: t.muted }}>
					{theme.tagline}
				</p>
			</div>
		</button>
	);
}
