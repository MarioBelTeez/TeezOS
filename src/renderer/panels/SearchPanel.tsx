import { useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, Regex } from "lucide-react";
import type { Workspace } from "../../main/settings/store.ts";
import type { SearchHit } from "../../main/workspace/search.ts";
import { useEditor } from "../state/editor.ts";
import { FileIcon } from "../explorer/FileIcon.tsx";
import { IconButton } from "../shell/IconButton.tsx";

/** Search in files; results grouped by file, a click jumps to the line. */
export function SearchPanel({ workspace }: { readonly workspace: Workspace }): React.JSX.Element {
	const [query, setQuery] = useState("");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [regex, setRegex] = useState(false);
	const [hits, setHits] = useState<SearchHit[] | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const request = useRef(0);

	useEffect(() => input.current?.focus(), []);

	useEffect(() => {
		const id = (request.current += 1);
		if (!query.trim()) {
			setHits(null);
			return;
		}
		const timer = setTimeout(() => {
			void window.teez.files.search(workspace.id, query, { caseSensitive, regex }).then((result) => {
				if (id === request.current) setHits(result);
			});
		}, 250);
		return () => clearTimeout(timer);
	}, [query, caseSensitive, regex, workspace.id]);

	const groups = useMemo(() => {
		const map = new Map<string, SearchHit[]>();
		for (const hit of hits ?? []) map.set(hit.path, [...(map.get(hit.path) ?? []), hit]);
		return [...map.entries()];
	}, [hits]);

	const highlight = (text: string): React.ReactNode => {
		if (regex || !query) return text;
		const index = (caseSensitive ? text : text.toLowerCase()).indexOf(caseSensitive ? query : query.toLowerCase());
		if (index === -1) return text;
		return (
			<>
				{text.slice(0, index)}
				<mark className="bg-red/35 text-text">{text.slice(index, index + query.length)}</mark>
				{text.slice(index + query.length)}
			</>
		);
	};

	return (
		<section className="flex h-full min-h-0 flex-col">
			<header className="flex h-9 shrink-0 items-center pl-4">
				<h2 className="font-condensed text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">Search</h2>
			</header>
			<div className="flex items-center gap-1 px-3 pb-2">
				<input
					ref={input}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={`Search ${workspace.name}`}
					className="min-w-0 flex-1 bg-bg px-2 py-1 font-mono text-[12px] text-text outline-none ring-1 ring-border focus:glow"
					spellCheck={false}
				/>
				<IconButton label="Match case" active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>
					<CaseSensitive size={15} />
				</IconButton>
				<IconButton label="Regular expression" active={regex} onClick={() => setRegex((v) => !v)}>
					<Regex size={14} />
				</IconButton>
			</div>
			{hits ? (
				<p className="px-4 pb-1 font-mono text-[10px] text-muted">
					{hits.length >= 800 ? "800+" : hits.length} results in {groups.length} files
				</p>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto pb-4">
				{groups.map(([path, fileHits]) => {
					const name = path.split("/").at(-1) ?? path;
					return (
						<div key={path} className="mb-1">
							<div className="flex items-center gap-1.5 px-3 py-0.5 text-[12.5px]" title={path}>
								<FileIcon name={name} />
								<span className="truncate">{name}</span>
								<span className="truncate font-mono text-[10px] text-muted">{path.slice(0, path.length - name.length)}</span>
								<span className="ml-auto font-mono text-[10px] text-muted">{fileHits.length}</span>
							</div>
							{fileHits.slice(0, 50).map((hit) => (
								<button
									key={`${hit.path}:${hit.line}`}
									type="button"
									onClick={() => void useEditor.getState().open(workspace.id, hit.path, { line: hit.line })}
									className="flex w-full gap-2 py-0.5 pr-2 pl-8 text-left font-mono text-[11px] text-muted hover:bg-white/[0.03] hover:text-text"
								>
									<span className="w-8 shrink-0 text-right opacity-60">{hit.line}</span>
									<span className="truncate">{highlight(hit.text.trim())}</span>
								</button>
							))}
						</div>
					);
				})}
			</div>
		</section>
	);
}
