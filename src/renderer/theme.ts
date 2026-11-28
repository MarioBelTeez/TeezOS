import { themeById, themeVars, type ThemeId } from "../shared/themes.ts";

/** Fired on window after a theme is applied; the editor listens so Monaco follows. */
export const THEME_EVENT = "teez:theme";

/**
 * Applies a theme by setting its colour tokens on the document root, which
 * outranks the defaults in index.css. Unknown ids fall back to BelTeez Crimson.
 */
export function applyTheme(id: string): ThemeId {
	const theme = themeById(id);
	const root = document.documentElement;
	for (const [name, value] of Object.entries(themeVars(theme))) root.style.setProperty(name, value);
	root.dataset["theme"] = theme.id;
	window.dispatchEvent(new CustomEvent<ThemeId>(THEME_EVENT, { detail: theme.id }));
	return theme.id;
}

/** The theme currently applied, from the root's data attribute. */
export function currentThemeId(): string {
	return document.documentElement.dataset["theme"] ?? "";
}
