import { readFileSync, writeFileSync } from "node:fs";
import { screen, type BrowserWindow, type Rectangle } from "electron";

/**
 * The window opens where it was closed: same size, same place, maximised or
 * not. A position on a monitor that is no longer connected is dropped, so the
 * window never opens off screen.
 */

export type WindowState = { readonly bounds: Rectangle | null; readonly maximized: boolean };

const DEFAULT: WindowState = { bounds: null, maximized: false };

function visible(bounds: Rectangle): boolean {
	return screen.getAllDisplays().some(({ workArea: area }) => {
		const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
		const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
		return overlapX > 120 && overlapY > 80;
	});
}

export function loadWindowState(file: string): WindowState {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<WindowState>;
		const b = parsed.bounds;
		const bounds =
			b && [b.x, b.y, b.width, b.height].every((n) => typeof n === "number" && Number.isFinite(n)) && b.width >= 600 && b.height >= 400 && visible(b)
				? b
				: null;
		return { bounds, maximized: parsed.maximized === true };
	} catch {
		return DEFAULT;
	}
}

export function trackWindowState(window: BrowserWindow, file: string): void {
	let timer: NodeJS.Timeout | null = null;
	const save = (): void => {
		if (window.isDestroyed()) return;
		const state: WindowState = {
			// Normal bounds even while maximised, so un-maximising restores them.
			bounds: window.getNormalBounds(),
			maximized: window.isMaximized(),
		};
		try {
			writeFileSync(file, JSON.stringify(state));
		} catch {
			// a missing userData folder is not worth failing over
		}
	};
	const later = (): void => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(save, 500);
	};
	window.on("resize", later);
	window.on("move", later);
	window.on("maximize", save);
	window.on("unmaximize", save);
	window.on("close", save);
}
