import type { TextSize } from "../../shared/modules.ts";

const ORDER: readonly TextSize[] = ["s", "m", "l"];

/**
 * The chat's text size after Ctrl+= / Ctrl+- / Ctrl+0, or null for any other
 * key. Steps stop at the ends rather than wrapping: pressing Ctrl+= once more
 * at the largest size must not drop to the smallest.
 */
export function textSizeForKey(current: TextSize, key: string): TextSize | null {
	const index = ORDER.indexOf(current);
	if (key === "=" || key === "+") return ORDER[Math.min(ORDER.length - 1, index + 1)] ?? current;
	if (key === "-" || key === "_") return ORDER[Math.max(0, index - 1)] ?? current;
	if (key === "0") return "m";
	return null;
}
