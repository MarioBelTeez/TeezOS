/**
 * A one-line summary of a tool's input, for the collapsed card header and the
 * hand-over to another agent. Kept out of `Cards.tsx` so pure code can use it
 * without importing a component file.
 */
export function summarize(input: Readonly<Record<string, unknown>>): string {
	const interesting = [
		"file_path",
		"path",
		"AbsolutePath",
		"command",
		"CommandLine",
		"pattern",
		"Query",
		"url",
		"description",
		"prompt",
	];
	for (const key of interesting) {
		const value = input[key];
		if (typeof value === "string" && value) return value.length > 160 ? `${value.slice(0, 160)}…` : value;
	}
	const [first] = Object.entries(input);
	return first ? `${first[0]}: ${JSON.stringify(first[1]).slice(0, 80)}` : "";
}
