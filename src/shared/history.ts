/**
 * A back/forward trail, one per area (Brain notes, editor files, app views).
 * Pushing the entry already in front is a no-op, so a screen that records
 * itself after a back/forward step does not cut the forward trail off.
 */
export type History<T> = {
	readonly push: (entry: T) => void;
	/** Steps back to the nearest entry `accept` allows; undefined (and no move) when there is none. */
	readonly back: (accept?: (entry: T) => boolean) => T | undefined;
	readonly forward: (accept?: (entry: T) => boolean) => T | undefined;
	readonly canBack: () => boolean;
	readonly canForward: () => boolean;
	readonly current: () => T | undefined;
};

export function createHistory<T>(max = 50): History<T> {
	let entries: readonly T[] = [];
	let position = -1;

	const step = (direction: 1 | -1, accept: (entry: T) => boolean): T | undefined => {
		for (let at = position + direction; at >= 0 && at < entries.length; at += direction) {
			const entry = entries[at] as T;
			if (!accept(entry)) continue;
			position = at;
			return entry;
		}
		return undefined;
	};

	return {
		push: (entry) => {
			if (position >= 0 && entries[position] === entry) return;
			entries = [...entries.slice(0, position + 1), entry].slice(-max);
			position = entries.length - 1;
		},
		back: (accept = () => true) => step(-1, accept),
		forward: (accept = () => true) => step(1, accept),
		canBack: () => position > 0,
		canForward: () => position < entries.length - 1,
		current: () => (position >= 0 ? entries[position] : undefined),
	};
}
