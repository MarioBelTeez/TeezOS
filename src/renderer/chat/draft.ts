/**
 * How text handed to the composer joins what is already typed there.
 *
 * - `append` (mentions from the tree, the editor, Brain): after the draft,
 *   separated by a space.
 * - `prefill` (the hand-over when switching agents): first, because it is
 *   context for whatever the user was about to say. A half-typed message is
 *   kept below it after a blank line rather than buried in front of it.
 */

export type InsertMode = "append" | "prefill";

export function combineDraft(previous: string, text: string, mode: InsertMode): string {
	if (mode === "prefill") {
		const typed = previous.trim();
		return typed ? `${text}\n\n${typed}` : text;
	}
	return previous && !previous.endsWith(" ") ? `${previous} ${text}` : `${previous}${text}`;
}
