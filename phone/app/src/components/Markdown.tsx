import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMathDelimiters } from "../../../../src/shared/math.ts";
import { safeHref } from "../links.ts";

/**
 * Replies as markdown, safely: no raw HTML, links only to http(s) and
 * mailto (opening in Safari, outside the app), anything else drawn as plain
 * text, and images never loaded (their alt text instead).
 */

const components: Components = {
	a: ({ href, children }) => {
		const safe = safeHref(href);
		if (!safe) return <span>{children}</span>;
		return (
			<a href={safe} target="_blank" rel="noopener noreferrer">
				{children}
			</a>
		);
	},
	img: ({ alt }) => (alt ? <span className="text-muted">[{alt}]</span> : null),
};

export function Markdown({ text }: { text: string }): ReactNode {
	return (
		<div className="prose-teez">
			<ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components} skipHtml>
				{normalizeMathDelimiters(text)}
			</ReactMarkdown>
		</div>
	);
}
