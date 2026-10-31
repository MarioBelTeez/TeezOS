import { describe, expect, it, vi } from "vitest";
import { terminalKeyHandler, type KeyTerm } from "./keys.ts";

function fakeTerm(selection = ""): KeyTerm & { pasted: string[] } {
	const pasted: string[] = [];
	return {
		pasted,
		hasSelection: () => selection.length > 0,
		getSelection: () => selection,
		clearSelection: vi.fn(),
		paste: (text: string) => void pasted.push(text),
	};
}

function key(init: Partial<KeyboardEvent>): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
	return { type: "keydown", key: "", ctrlKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), ...init } as never;
}

const clipboard = (text: string) => ({ readText: vi.fn(async () => text), writeText: vi.fn(async () => undefined) });

describe("terminalKeyHandler", () => {
	it("pastes once on Ctrl+V and cancels the browser's own paste", async () => {
		const term = fakeTerm();
		const board = clipboard("ls -la");
		const event = key({ key: "v", ctrlKey: true });

		const handled = terminalKeyHandler(term, board)(event);
		await Promise.resolve();
		await Promise.resolve();

		expect(handled).toBe(false);
		// Without this the native paste event reaches xterm's textarea and the text lands twice.
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(term.pasted).toEqual(["ls -la"]);
	});

	it("copies the selection on Ctrl+C and clears it", () => {
		const term = fakeTerm("hello");
		const board = clipboard("");
		const handled = terminalKeyHandler(term, board)(key({ key: "c", ctrlKey: true }));

		expect(handled).toBe(false);
		expect(board.writeText).toHaveBeenCalledWith("hello");
		expect(term.clearSelection).toHaveBeenCalledOnce();
	});

	it("leaves Ctrl+C to the shell when nothing is selected", () => {
		expect(terminalKeyHandler(fakeTerm(), clipboard(""))(key({ key: "c", ctrlKey: true }))).toBe(true);
	});

	it("ignores keyup so a paste is not repeated on release", () => {
		const term = fakeTerm();
		const event = key({ type: "keyup", key: "v", ctrlKey: true });
		expect(terminalKeyHandler(term, clipboard("x"))(event)).toBe(true);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("lets the app's own shortcuts through and keeps the shell's", () => {
		const handle = terminalKeyHandler(fakeTerm(), clipboard(""));
		expect(handle(key({ key: "`", ctrlKey: true }))).toBe(false);
		expect(handle(key({ key: "P", ctrlKey: true, shiftKey: true }))).toBe(false);
		expect(handle(key({ key: "3", altKey: true }))).toBe(false);
		expect(handle(key({ key: "Tab", ctrlKey: true }))).toBe(false);
		expect(handle(key({ key: "k", ctrlKey: true }))).toBe(true);
		expect(handle(key({ key: "a" }))).toBe(true);
	});
});
