import { useEffect, useState } from "react";
import { getModel } from "../state/editor.ts";
import { MarkdownText } from "../chat/Cards.tsx";

/** Files the preview button and Ctrl+Shift+V apply to. */
export const isMarkdown = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path);

/**
 * A Markdown file rendered, as VS Code's preview does. It reads the open model,
 * so unsaved edits and reloads from disk show as they happen; frontmatter is
 * left out, as Obsidian and GitHub do.
 */
export function MarkdownPreview({ workspaceId, path }: { readonly workspaceId: string; readonly path: string }): React.JSX.Element {
	const model = getModel(workspaceId, path);
	const [text, setText] = useState(() => model?.getValue() ?? "");

	useEffect(() => {
		if (!model) return;
		setText(model.getValue());
		const subscription = model.onDidChangeContent(() => setText(model.getValue()));
		return () => subscription.dispose();
	}, [model]);

	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	return (
		<div className="h-full overflow-y-auto px-10 py-8">
			<div className="mx-auto max-w-3xl text-[14px]">
				<MarkdownText text={body} />
			</div>
		</div>
	);
}
