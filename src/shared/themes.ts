/**
 * Colour themes. Each one overrides the CSS colour tokens from index.css
 * (`--color-red`, `--color-bg`, …) at runtime, so every Tailwind class built
 * on them follows. Palettes match SteamFamTrack's Themes so the two apps agree.
 *
 * Dark themes only: the glass panels, glows and vignette are designed for a
 * dark ground, and a light theme needs its own pass over them.
 */

export const THEME_IDS = [
	"belteez-crimson",
	"steam-blue",
	"midnight-blurple",
	"catppuccin-mocha",
	"nord-frost",
	"clean-dark",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME_ID: ThemeId = "belteez-crimson";

export type ThemeTokens = {
	/** The accent. Named "red" because every class and token in the app is. */
	readonly red: string;
	readonly redHot: string;
	/** The accent as "r g b", for translucent uses: rgb(var(--color-red-rgb) / 0.2). */
	readonly redRgb: string;
	/** Text on a solid accent fill: white on dark accents, near-black on pastel ones. */
	readonly onRed: string;
	readonly bg: string;
	readonly surface: string;
	readonly surface2: string;
	readonly border: string;
	readonly muted: string;
	readonly text: string;
};

export type Theme = { readonly id: ThemeId; readonly name: string; readonly tagline: string; readonly tokens: ThemeTokens };

export const THEMES: readonly Theme[] = [
	{
		id: "belteez-crimson",
		name: "BelTeez Crimson",
		tagline: "The original: signature red on obsidian",
		tokens: {
			red: "#e8002d",
			redHot: "#ff1744",
			redRgb: "232 0 45",
			onRed: "#ffffff",
			bg: "#050307",
			surface: "#0e0a0d",
			surface2: "#161015",
			border: "#2a1f24",
			muted: "#958289",
			text: "#f5f0f2",
		},
	},
	{
		id: "steam-blue",
		name: "Steam Deck Blue",
		tagline: "Big Picture navy and electric sky blue",
		tokens: {
			red: "#1a9fff",
			redHot: "#47b5ff",
			redRgb: "26 159 255",
			onRed: "#ffffff",
			bg: "#0d131a",
			surface: "#151f2b",
			surface2: "#1c2a3b",
			border: "#2a3e54",
			muted: "#93a7bc",
			text: "#f3f8fc",
		},
	},
	{
		id: "midnight-blurple",
		name: "Midnight Blurple",
		tagline: "Cozy indigo with crisp blurple highlights",
		tokens: {
			red: "#7c6bff",
			redHot: "#9485ff",
			redRgb: "124 107 255",
			onRed: "#ffffff",
			bg: "#0c0d14",
			surface: "#131521",
			surface2: "#1b1e30",
			border: "#2c314a",
			muted: "#9aa0bc",
			text: "#f5f6fc",
		},
	},
	{
		id: "catppuccin-mocha",
		name: "Catppuccin Violet",
		tagline: "Soothing dark crust with pastel mauve",
		tokens: {
			red: "#cba6f7",
			redHot: "#dec2ff",
			redRgb: "203 166 247",
			onRed: "#11111b",
			bg: "#11111b",
			surface: "#181825",
			surface2: "#1e1e2e",
			border: "#313244",
			muted: "#a6adc8",
			text: "#cdd6f4",
		},
	},
	{
		id: "nord-frost",
		name: "Nord Frost",
		tagline: "Low-strain arctic slate and glacier blue",
		tokens: {
			red: "#88c0d0",
			redHot: "#a3d4e2",
			redRgb: "136 192 208",
			onRed: "#161b22",
			bg: "#1c212b",
			surface: "#242a36",
			surface2: "#2e3440",
			border: "#3e4759",
			muted: "#a6b2c5",
			text: "#eceff4",
		},
	},
	{
		id: "clean-dark",
		name: "Obsidian Dark",
		tagline: "Neutral carbon with electric cyan",
		tokens: {
			red: "#38bdf8",
			redHot: "#7dd3fc",
			redRgb: "56 189 248",
			onRed: "#07131a",
			bg: "#09090b",
			surface: "#111114",
			surface2: "#18181d",
			border: "#27272f",
			muted: "#a1a1aa",
			text: "#fafafa",
		},
	},
];

export function isThemeId(value: unknown): value is ThemeId {
	return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

export function themeById(id: string): Theme {
	return THEMES.find((t) => t.id === id) ?? (THEMES[0] as Theme);
}

/** "#0e0a0d" → "14 10 13". */
function hexToRgb(hex: string): string {
	const n = Number.parseInt(hex.slice(1), 16);
	return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** The CSS custom properties a theme sets on the document root. */
export function themeVars(theme: Theme): Readonly<Record<string, string>> {
	const t = theme.tokens;
	return {
		"--color-red": t.red,
		"--color-red-hot": t.redHot,
		"--color-red-rgb": t.redRgb,
		"--color-on-red": t.onRed,
		"--color-bg": t.bg,
		"--color-surface": t.surface,
		"--color-surface-2": t.surface2,
		"--color-border": t.border,
		"--color-muted": t.muted,
		"--color-text": t.text,
		"--color-glow": `rgb(${t.redRgb} / 0.42)`,
		"--color-glass": `rgb(${hexToRgb(t.surface)} / 0.72)`,
	};
}
