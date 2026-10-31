const NEAR_PX = 80;

/** True when the reader is at (or within 80 px of) the end of a scrolling list, so new content may follow them down. */
export function nearBottom(box: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
	return box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_PX;
}
