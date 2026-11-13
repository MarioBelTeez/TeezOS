/**
 * Normalizes LaTeX delimiters `\[ ... \]` and `\( ... \)` into `$$ ... $$` and `$ ... $`
 * so `remark-math` renders them, while leaving fenced and inline code blocks untouched.
 */
export function normalizeMathDelimiters(text: string): string {
	if (!text.includes("\\(") && !text.includes("\\[")) return text;

	// Split by fenced code blocks (```...```) or inline code (`...`) to avoid mutating code.
	const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
	return parts
		.map((part, index) => {
			if (index % 2 === 1) return part;
			return part
				.replace(/\\\[([\s\S]*?)\\\]/g, (_match, inner: string) => `$$${inner}$$`)
				.replace(/\\\(([\s\S]*?)\\\)/g, (_match, inner: string) => `$${inner.trim()}$`);
		})
		.join("");
}
