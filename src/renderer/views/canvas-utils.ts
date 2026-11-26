import type { CanvasDocument } from "../state/ui.ts";

export type ExtractedArtifact = Omit<CanvasDocument, "nonce"> & { readonly id: string };

/**
 * Extracts renderable SVG and HTML code blocks from assistant markdown messages
 * so the Canvas Viewer can display agent drawings/mockups with one click.
 */
export function extractArtifactsFromMarkdown(markdown: string, prefix = "chat"): ExtractedArtifact[] {
	const results: ExtractedArtifact[] = [];
	const fence = /```(svg|html)\s*\r?\n([\s\S]*?)```/gi;
	let match: RegExpExecArray | null;
	let index = 0;
	while ((match = fence.exec(markdown)) !== null) {
		const lang = (match[1] ?? "").toLowerCase();
		const body = (match[2] ?? "").trim();
		if (!body) continue;
		index += 1;
		results.push({
			id: `${prefix}-${lang}-${index}`,
			title: lang === "svg" ? `Agent SVG #${index}` : `Agent HTML #${index}`,
			kind: lang === "svg" ? "svg" : "html",
			content: body,
		});
	}
	return results;
}

/** Detects Canvas Viewer document kind from a workspace file path. */
export function canvasKindForPath(filePath: string): CanvasDocument["kind"] | null {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".svg")) return "svg";
	if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
	if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) return "markdown";
	return null;
}

/**
 * Wraps raw SVG or HTML inside a clean, self-contained HTML document suitable
 * for a sandboxed `<iframe sandbox="">` (no script execution, no parent access).
 */
export function buildSandboxedSrcDoc(kind: "svg" | "html", content: string): string {
	if (kind === "svg") {
		return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:16px;min-height:100%;box-sizing:border-box;background:#ffffff;display:flex;align-items:center;justify-content:center;}
svg{max-width:100%;height:auto;display:block;}
</style></head><body>${content}</body></html>`;
	}
	return content;
}
