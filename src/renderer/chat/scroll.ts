/**
 * Whether the conversation should follow the bottom: always when a chat has
 * just been opened or switched to (it opens at its newest message), and
 * otherwise whatever the reader last chose by scrolling within that chat.
 */
export function stickAfterChatChange(previousChatId: string | null, chatId: string, stick: boolean): boolean {
	return previousChatId !== chatId ? true : stick;
}

/** How long after a wheel, touch, key or pointer input a scroll still counts as the reader's. */
export const READER_INPUT_WINDOW_MS = 800;

export function isReaderScroll(lastReaderInputAt: number | null, now: number): boolean {
	return lastReaderInputAt !== null && now - lastReaderInputAt <= READER_INPUT_WINDOW_MS;
}

/**
 * After a scroll event: only the reader can stop the chat following the
 * bottom. Chromium also scrolls on its own (scroll anchoring when code or
 * images finish rendering above, a panel shown or resized), and treating that
 * as "scrolled up" left chats stuck mid-way. And only a scroll *up*: the
 * app's own follow-scroll moves down, even right after a click on Copy or
 * Approve. Reaching the bottom always follows again.
 */
export function stickAfterScroll({
	stick,
	atBottom,
	byReader,
	movedUp,
}: {
	readonly stick: boolean;
	readonly atBottom: boolean;
	readonly byReader: boolean;
	readonly movedUp: boolean;
}): boolean {
	if (atBottom) return true;
	return byReader && movedUp ? false : stick;
}

/** Keys that scroll the conversation; typed into a text box they don't. */
export const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);
