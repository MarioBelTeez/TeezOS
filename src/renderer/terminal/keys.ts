/** The bits of an xterm `Terminal` the key handler needs. */
export type KeyTerm = {
	hasSelection(): boolean;
	getSelection(): string;
	clearSelection(): void;
	paste(text: string): void;
};

export type KeyClipboard = Pick<Clipboard, "readText" | "writeText">;

/**
 * The terminal's custom key handler: Ctrl+C copies when there is a selection,
 * Ctrl+V pastes (as Windows Terminal does), and the app's own shortcuts pass
 * through. `false` means xterm ignores the key.
 */
export function terminalKeyHandler(term: KeyTerm, clipboard: KeyClipboard = navigator.clipboard): (event: KeyboardEvent) => boolean {
	return (event) => {
		if (event.type !== "keydown") return true;
		if (event.ctrlKey && event.key === "c" && term.hasSelection()) {
			void clipboard.writeText(term.getSelection());
			term.clearSelection();
			return false;
		}
		if (event.ctrlKey && event.key === "v") {
			// Returning false only stops xterm's keydown handling. The browser
			// still fires its native paste on xterm's textarea, which xterm
			// pastes too: cancel it, or every Ctrl+V lands twice.
			event.preventDefault();
			// term.paste wraps it in bracketed-paste markers: a pasted multi-line
			// command lands in the prompt instead of running line by line.
			void clipboard.readText().then((text) => term.paste(text));
			return false;
		}
		// Let the app's own shortcuts through — but only ones no shell needs:
		// Ctrl+P, K, W, B and J stay with the shell (history, kill line, ...).
		if (event.ctrlKey && !event.shiftKey && /^[`1234,]$/.test(event.key)) return false;
		if (event.ctrlKey && event.shiftKey && /^[pf]$/i.test(event.key)) return false;
		if (event.altKey && /^[1-9]$/.test(event.key)) return false;
		// Ctrl+Tab switches desks; no shell uses it.
		if (event.ctrlKey && event.key === "Tab") return false;
		return true;
	};
}
