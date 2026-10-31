/**
 * The order of a workspace's chat tabs. New chats join at the end; dragging
 * a tab moves it before or after another. Kept as ids so the chats
 * themselves never change when their tab moves.
 */

/** `order` with `moved` placed before (or `after`) `target`; the same array when nothing moves. */
export function moveTab(order: readonly string[], moved: string, target: string, after: boolean): readonly string[] {
	if (moved === target || !order.includes(moved) || !order.includes(target)) return order;
	const rest = order.filter((id) => id !== moved);
	const at = rest.indexOf(target) + (after ? 1 : 0);
	return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

/**
 * The chat to close so one more can open, when a workspace already has `max`:
 * the oldest idle one. Never a running chat (it would lose its turn), never
 * `keep` (the chat being switched away from stays beside the new one). Null
 * when there is room, or nothing may be closed.
 */
export function chatToEvict<T extends { readonly chatId: string; readonly createdAt: number; readonly running: boolean }>(
	chats: readonly T[],
	keep: string | undefined,
	max: number,
): T | null {
	if (chats.length < max) return null;
	const idle = chats.filter((c) => !c.running && c.chatId !== keep).sort((a, b) => a.createdAt - b.createdAt);
	return idle[0] ?? null;
}

/**
 * The chats in tab order. Any chat the order does not know yet (it arrived
 * before its tab was recorded) goes at the end, oldest first, so no chat is
 * ever left without a tab.
 */
export function orderedTabs<T extends { readonly chatId: string; readonly createdAt: number }>(
	chats: readonly T[],
	order: readonly string[],
): T[] {
	const byId = new Map(chats.map((c) => [c.chatId, c]));
	const known = order.flatMap((id) => {
		const chat = byId.get(id);
		return chat ? [chat] : [];
	});
	const listed = new Set(order);
	const rest = chats.filter((c) => !listed.has(c.chatId)).sort((a, b) => a.createdAt - b.createdAt);
	return [...known, ...rest];
}
