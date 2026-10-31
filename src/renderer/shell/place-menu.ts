/**
 * Where a menu goes so it never spills out of the window. It opens at the
 * point when it fits below; otherwise it flips to sit directly above its
 * anchor (the top of the button that opened it, or the point itself), which
 * is what a picker at the bottom of the chat needs. Too tall for either side,
 * it hugs the bottom edge. Horizontally it is pulled left to stay on screen.
 */

const MARGIN = 6;

type Size = { readonly width: number; readonly height: number };

export function placeMenu(
	at: { readonly x: number; readonly y: number; readonly anchorTop?: number },
	size: Size,
	viewport: Size,
): { left: number; top: number } {
	const left = Math.max(0, Math.min(at.x, viewport.width - size.width - MARGIN));
	if (at.y + size.height + MARGIN <= viewport.height) return { left, top: at.y };
	const above = (at.anchorTop ?? at.y) - size.height;
	if (above >= 0) return { left, top: above };
	return { left, top: Math.max(0, viewport.height - size.height - MARGIN) };
}

/**
 * A popover over the chat's composer (the `/` menu, /btw, /context): always
 * upward from the composer's top, which it must not cover while there is
 * room; with none, it stays on screen rather than going off the top.
 */
export function placeAbove(
	anchor: { readonly left: number; readonly top: number },
	size: Size,
	viewport: Size,
): { left: number; top: number } {
	// A point at the window's bottom never "fits below", so placeMenu takes
	// its upward branch: directly above the anchor, else hugging the bottom.
	return placeMenu({ x: anchor.left, y: viewport.height, anchorTop: anchor.top - 4 }, size, viewport);
}
