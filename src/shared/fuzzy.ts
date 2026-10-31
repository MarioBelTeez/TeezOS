/** Shared by the main process and the window: it imports nothing. */

/**
 * Fuzzy score of `query` against a path: every query character must appear in
 * order; matches in the file name, at word starts and in runs score higher.
 * Returns null when it does not match at all.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
	const q = query.toLowerCase().replace(/\s+/g, "");
	if (!q) return 0;
	const c = candidate.toLowerCase();
	const nameStart = c.lastIndexOf("/") + 1;
	let score = 0;
	let position = -1;
	let run = 0;
	for (const char of q) {
		const found = c.indexOf(char, position + 1);
		if (found === -1) return null;
		run = found === position + 1 ? run + 1 : 0;
		score += 1 + run * 2;
		if (found >= nameStart) score += 2;
		const before = c[found - 1];
		if (found === nameStart || before === "/" || before === "-" || before === "_" || before === "." || before === " ") score += 3;
		// camelCase humps count as word starts: "cp" finds ChatPanel.
		else if (candidate[found] !== c[found] && candidate[found - 1] === c[found - 1]) score += 3;
		position = found;
	}
	// Shorter paths win ties: "index.ts" over "deep/nested/index.ts".
	return score - candidate.length * 0.01;
}
