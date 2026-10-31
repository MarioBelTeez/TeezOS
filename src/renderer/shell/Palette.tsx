import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { fuzzyScore } from "../../shared/fuzzy.ts";
import { useUi } from "../state/ui.ts";
import { useActiveWorkspace } from "../state/settings.ts";
import { useEditor } from "../state/editor.ts";
import { FileIcon } from "../explorer/FileIcon.tsx";
import { buildCommands, type Command } from "./commands.ts";
import { revealPanel } from "./dock-actions.ts";
import { POP_IN } from "./motion.ts";

/**
 * Ctrl+P finds a file, Ctrl+K runs a command. Typing ">" in the file box
 * switches to commands, as in VS Code.
 */

/** File lists per workspace, refreshed when the palette opens on a stale one. */
const indexCache = new Map<string, { readonly files: readonly string[]; readonly at: number }>();
const STALE_MS = 15_000;

type Row =
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "command"; readonly command: Command };

export function Palette(): React.JSX.Element | null {
	const mode = useUi((s) => s.palette);
	const close = useUi((s) => s.closePalette);
	const workspace = useActiveWorkspace();
	const [query, setQuery] = useState("");
	const [files, setFiles] = useState<readonly string[]>([]);
	const [selected, setSelected] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (mode === "closed") return;
		setQuery(mode === "commands" ? ">" : "");
		setSelected(0);
		input.current?.focus();
		if (mode === "files" && workspace) {
			const cached = indexCache.get(workspace.id);
			if (cached) setFiles(cached.files);
			if (!cached || Date.now() - cached.at > STALE_MS) {
				void window.teez.files.index(workspace.id).then((result) => {
					indexCache.set(workspace.id, { files: result, at: Date.now() });
					setFiles(result);
				});
			}
		}
	}, [mode, workspace]);

	const commandMode = query.startsWith(">");
	const rows: Row[] = useMemo(() => {
		if (mode === "closed") return [];
		if (commandMode) {
			const q = query.slice(1).trim();
			return buildCommands()
				.map((command) => ({ command, score: fuzzyScore(q, command.label) }))
				.filter((x) => x.score !== null)
				.sort((a, b) => (q ? (b.score ?? 0) - (a.score ?? 0) : 0))
				.slice(0, 60)
				.map((x) => ({ kind: "command", command: x.command }));
		}
		if (!query.trim()) {
			const open = workspace ? (useEditor.getState().byWorkspace[workspace.id]?.tabs ?? []).map((t) => t.path) : [];
			return [...open, ...files.filter((f) => !open.includes(f))].slice(0, 60).map((path) => ({ kind: "file", path }));
		}
		return files
			.map((path) => ({ path, score: fuzzyScore(query, path) }))
			.filter((x) => x.score !== null)
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
			.slice(0, 60)
			.map((x) => ({ kind: "file", path: x.path }));
	}, [mode, query, files, commandMode, workspace]);

	useEffect(() => {
		list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	if (mode === "closed") return null;

	const choose = (row: Row | undefined): void => {
		if (!row) return;
		close();
		if (row.kind === "command") row.command.run();
		else if (workspace) {
			revealPanel("editor");
			void useEditor.getState().open(workspace.id, row.path);
		}
	};

	return (
		<div className="fixed inset-0 z-40 flex justify-center bg-black/50 pt-16" onMouseDown={close}>
			<motion.div
				{...POP_IN}
				className="glass flex h-fit max-h-[60vh] w-[min(640px,90vw)] flex-col border border-red/25"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<input
					ref={input}
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setSelected(0);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") close();
						if (event.key === "ArrowDown") {
							event.preventDefault();
							setSelected((i) => Math.min(rows.length - 1, i + 1));
						}
						if (event.key === "ArrowUp") {
							event.preventDefault();
							setSelected((i) => Math.max(0, i - 1));
						}
						if (event.key === "Enter") choose(rows[selected]);
					}}
					placeholder={commandMode ? "Run a command…" : workspace ? `Find a file in ${workspace.name} — or > for commands` : "Pin a folder first"}
					className="border-b border-red/30 bg-black/40 px-3 py-2.5 font-mono text-[13px] text-text outline-none placeholder:text-muted/70"
					spellCheck={false}
				/>
				<div ref={list} className="min-h-0 overflow-y-auto py-1">
					{rows.map((row, index) => {
						const isSelected = index === selected;
						if (row.kind === "command") {
							return (
								<button
									key={row.command.id}
									type="button"
									data-index={index}
									onMouseMove={() => setSelected(index)}
									onClick={() => choose(row)}
									className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] ${isSelected ? "bg-red/20 shadow-[inset_2px_0_0_var(--color-red-hot)]" : ""}`}
								>
									{row.command.label}
									{row.command.keys ? <span className="font-mono text-[10px] text-muted">{row.command.keys}</span> : null}
								</button>
							);
						}
						const name = row.path.split("/").at(-1) ?? row.path;
						const dir = row.path.slice(0, row.path.length - name.length - 1);
						return (
							<button
								key={row.path}
								type="button"
								data-index={index}
								onMouseMove={() => setSelected(index)}
								onClick={() => choose(row)}
								className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] ${isSelected ? "bg-red/20 shadow-[inset_2px_0_0_var(--color-red-hot)]" : ""}`}
							>
								<FileIcon name={name} />
								<span className="shrink-0">{name}</span>
								<span className="truncate font-mono text-[10.5px] text-muted">{dir}</span>
							</button>
						);
					})}
					{rows.length === 0 ? <p className="px-3 py-2 font-mono text-xs text-muted">No match.</p> : null}
				</div>
			</motion.div>
		</div>
	);
}
