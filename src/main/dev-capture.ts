import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { app, nativeImage, WebContentsView, type BrowserWindow, type NativeImage } from "electron";
import { captureConfig, captureHeight, type CaptureConfig } from "./capture-config.ts";

/**
 * Visual QA for dev builds: the app photographs its own window
 * (webContents.capturePage) at a few widths and writes PNGs. It never reads
 * the screen and never shows the window, so it can run while the PC is in
 * use. Packaged builds ignore it. See capture-config.ts for the variables.
 */

const SETTLE_AFTER_LOAD_MS = 4000;
const SETTLE_AFTER_VIEW_MS = 1500;
const SETTLE_AFTER_RESIZE_MS = 1500;

/** Read once: the environment does not change while the app runs. */
const config: CaptureConfig | null = captureConfig(process.env, app.isPackaged);

/** True while running as a capture: the window stays hidden and nothing personal is written. */
export function isCaptureMode(): boolean {
	return config !== null;
}

/**
 * A capture runs on a copy of the user's settings in a temp profile, so the
 * real settings, window position and browser storage are never written by
 * it (and it does not fight a running TeezAI for them). Call before ready.
 */
export function prepareCaptureProfile(): void {
	if (!config) return;
	const real = app.getPath("userData");
	const profile = join(tmpdir(), "teezai-capture-profile");
	mkdirSync(profile, { recursive: true });
	for (const name of ["settings.json", "workspace-icons"]) {
		const source = join(real, name);
		if (existsSync(source)) cpSync(source, join(profile, name), { recursive: true, force: true });
	}
	app.setPath("userData", profile);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const FRAME_PUMP_MS = 100;

/** The window's page and the browser tabs drawn over it (visible ones only). */
function childPages(window: BrowserWindow): WebContentsView[] {
	return window.contentView.children.filter((view): view is WebContentsView => view instanceof WebContentsView && view.getVisible());
}

/**
 * A hidden window paints a frame only when asked, so whatever is laid out by
 * a ResizeObserver or requestAnimationFrame (the dock's panel grid, the Brain
 * graph's simulation) only moves on while frames are being asked for. Keep
 * asking for the whole wait, the browser tabs included.
 */
async function settle(window: BrowserWindow, ms: number): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end && !window.isDestroyed()) {
		window.webContents.invalidate();
		for (const view of childPages(window)) view.webContents.invalidate();
		await wait(FRAME_PUMP_MS);
	}
}

const REPAINT_MS = 300;

/**
 * A hidden window can keep a composited layer clipped to the size it was
 * first painted at: with the Brain graph open, the whole panel grid stayed
 * in the window's old 1440 x 810 corner of a 2560 shot even though the DOM
 * was laid out at 2560. Putting the page on a fresh layer and back makes
 * Chromium rebuild every layer at the current size. Capture only.
 */
async function repaintAll(window: BrowserWindow): Promise<void> {
	await window.webContents.executeJavaScript(`void (document.documentElement.style.transform = "translateZ(0)")`);
	await settle(window, REPAINT_MS);
	await window.webContents.executeJavaScript(`void (document.documentElement.style.transform = "")`);
	await settle(window, REPAINT_MS);
}

/**
 * One browser tab's pixels. A tab that has not produced a frame yet fails
 * (UnknownVizError): give it a moment and try once more; if it still fails,
 * its placeholder stays in the shot rather than failing the whole capture.
 */
async function capturePageOf(window: BrowserWindow, view: WebContentsView): Promise<NativeImage | null> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await view.webContents.capturePage(undefined, { stayHidden: true });
		} catch (error: unknown) {
			if (attempt >= 2) {
				console.log(`[capture] browser tab not captured: ${String(error)}`);
				return null;
			}
			await settle(window, SETTLE_AFTER_VIEW_MS);
		}
	}
}

/**
 * capturePage photographs the window's own page only; the built-in browser
 * draws each tab as a native WebContentsView on top of it, which the shot
 * would show as an empty hole. Each visible one is captured too and copied
 * into the window's pixels at its bounds, so the PNG shows what is on screen.
 */
async function withChildViews(window: BrowserWindow, shot: NativeImage): Promise<NativeImage> {
	const views = childPages(window);
	if (views.length === 0) return shot;
	const { width, height } = shot.getSize();
	const scale = width / Math.max(1, window.getContentSize()[0] ?? width);
	const pixels = Buffer.from(shot.toBitmap());
	for (const view of views) {
		const bounds = view.getBounds();
		const w = Math.round(bounds.width * scale);
		const h = Math.round(bounds.height * scale);
		if (w <= 0 || h <= 0 || view.webContents.isDestroyed()) continue;
		let page = await capturePageOf(window, view);
		if (!page || page.isEmpty()) continue;
		if (page.getSize().width !== w || page.getSize().height !== h) page = page.resize({ width: w, height: h, quality: "best" });
		const source = page.toBitmap();
		const left = Math.round(bounds.x * scale);
		const top = Math.round(bounds.y * scale);
		// Both bitmaps are 4 bytes a pixel in the same order: copy row by row, clipped to the window.
		const cols = Math.min(w, width - left);
		for (let row = 0; row < h && top + row < height; row++) {
			if (top + row < 0 || cols <= 0 || left < 0) continue;
			source.copy(pixels, ((top + row) * width + left) * 4, row * w * 4, (row * w + cols) * 4);
		}
	}
	return nativeImage.createFromBitmap(pixels, { width, height });
}

async function capture(window: BrowserWindow, settings: CaptureConfig): Promise<void> {
	mkdirSync(settings.folder, { recursive: true });
	await settle(window, SETTLE_AFTER_LOAD_MS);
	if (settings.view) {
		// A dev-only hook that App.tsx installs; the view id was validated against VIEW_IDS.
		await window.webContents.executeJavaScript(`window.__teezShowView?.(${JSON.stringify(settings.view)})`);
		await settle(window, SETTLE_AFTER_VIEW_MS);
	}
	for (const width of settings.widths) {
		if (window.isDestroyed()) return;
		const height = captureHeight(width);
		window.setContentSize(width, height);
		// A hidden window only repaints when asked; keep asking, so the layout catches up with the new size.
		await settle(window, SETTLE_AFTER_RESIZE_MS);
		await repaintAll(window);
		const image = await withChildViews(window, await window.webContents.capturePage());
		const size = image.getSize();
		// At a display scale above 100 % the pixels are denser than the layout; keep the layout's size.
		const png = size.width === width ? image.toPNG() : image.resize({ width, quality: "best" }).toPNG();
		const file = join(settings.folder, `teezai-${width}.png`);
		writeFileSync(file, png);
		const [contentWidth, contentHeight] = window.getContentSize();
		console.log(`[capture] ${file} (layout ${contentWidth}x${contentHeight}, captured ${size.width}x${size.height})`);
	}
}

/** In capture mode: once the page has loaded and settled, photograph it at each width, then maybe quit. */
export function maybeCapture(window: BrowserWindow): void {
	const settings = config;
	if (!settings) return;
	// The page's warnings and errors go to the terminal, so a broken render is visible next to the PNGs.
	window.webContents.on("console-message", (event) => {
		if (event.level === "warning" || event.level === "error") console.log(`[capture:${event.level}] ${event.message}`);
	});
	window.webContents.once("did-finish-load", () => {
		capture(window, settings)
			.catch((error: unknown) => console.error("[capture] failed:", error))
			.finally(() => {
				if (settings.quit) app.quit();
			});
	});
}
