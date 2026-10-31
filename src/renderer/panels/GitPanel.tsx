import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Check, RefreshCw } from "lucide-react";
import type { Workspace } from "../../main/settings/store.ts";
import { useTree } from "../state/tree.ts";
import { useEditor } from "../state/editor.ts";
import { useUi } from "../state/ui.ts";
import { FileIcon, GIT_COLORS } from "../explorer/FileIcon.tsx";
import { IconButton } from "../shell/IconButton.tsx";

/**
 * Source control: tick files, write a message, commit; pull and push.
 * Only ticked files are committed. In the vault the message style is
 * `vault: <what changed>`, so that is the placeholder there.
 */
export function GitPanel({ workspace }: { readonly workspace: Workspace }): React.JSX.Element {
	const git = useTree((s) => s.trees[workspace.id]?.git ?? null);
	const refreshGit = useTree((s) => s.refreshGit);
	const [ticked, setTicked] = useState<Readonly<Record<string, boolean>>>({});
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const files = useMemo(() => Object.entries(git?.files ?? {}).sort(([a], [b]) => a.localeCompare(b)), [git]);
	const isVault = workspace.name.toLowerCase() === "teezmind";

	useEffect(() => {
		void refreshGit(workspace.id);
	}, [workspace.id, refreshGit]);

	// Nothing is ticked until you tick it: a change you did not make (another
	// agent's unfinished work in a shared tree) must not ride along by default.
	useEffect(() => {
		setTicked((previous) => Object.fromEntries(files.map(([path]) => [path, previous[path] ?? false])));
	}, [files]);

	const chosen = files.filter(([path]) => ticked[path]).map(([path]) => path);

	const run = async (label: string, action: () => Promise<{ ok: boolean; output: string }>): Promise<void> => {
		setBusy(label);
		try {
			const result = await action();
			useUi.getState().toast(result.output || (result.ok ? `${label} done.` : `${label} failed.`), result.ok ? "success" : "error");
			if (result.ok && label === "Commit") setMessage("");
		} finally {
			setBusy(null);
			void refreshGit(workspace.id);
		}
	};

	if (!git) {
		return <p className="p-4 font-mono text-[11px] text-muted">This folder is not a git repository.</p>;
	}

	return (
		<section className="flex h-full min-h-0 flex-col">
			<header className="flex h-9 shrink-0 items-center justify-between pl-4 pr-1">
				<h2 className="font-condensed text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
					{git.branch} {git.ahead ? `↑${git.ahead}` : ""} {git.behind ? `↓${git.behind}` : ""}
				</h2>
				<div className="flex">
					<IconButton label="Pull (fast-forward only)" disabled={busy !== null} onClick={() => void run("Pull", () => window.teez.git.pull(workspace.id))}>
						<ArrowDownToLine size={14} />
					</IconButton>
					<IconButton label="Push" disabled={busy !== null} onClick={() => void run("Push", () => window.teez.git.push(workspace.id))}>
						<ArrowUpFromLine size={14} />
					</IconButton>
					<IconButton label="Refresh" onClick={() => void refreshGit(workspace.id)}>
						<RefreshCw size={14} />
					</IconButton>
				</div>
			</header>
			<div className="px-3 pb-2">
				<textarea
					value={message}
					onChange={(event) => setMessage(event.target.value)}
					rows={2}
					placeholder={isVault ? "vault: what changed" : "Commit message"}
					className="w-full resize-none bg-bg px-2 py-1.5 font-mono text-[12px] text-text outline-none ring-1 ring-border focus:glow"
				/>
				<button
					type="button"
					disabled={busy !== null || !message.trim() || chosen.length === 0}
					onClick={() => void run("Commit", () => window.teez.git.commit(workspace.id, chosen, message))}
					className="mt-1.5 flex w-full items-center justify-center gap-2 cut-corner bg-red py-1.5 font-condensed text-xs font-semibold uppercase tracking-wider disabled:bg-border disabled:text-muted"
				>
					<Check size={13} />
					{busy === "Commit" ? "Committing…" : `Commit ${chosen.length} file${chosen.length === 1 ? "" : "s"}`}
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto pb-4">
				{files.length === 0 ? <p className="px-4 font-mono text-[11px] text-muted">No changes.</p> : (
					<label className="flex items-center gap-2 px-3 py-1 font-mono text-[10px] text-muted">
						<input
							type="checkbox"
							checked={chosen.length === files.length}
							onChange={(event) => setTicked(Object.fromEntries(files.map(([path]) => [path, event.target.checked])))}
							className="accent-[#e8002d]"
						/>
						{chosen.length} of {files.length} selected
					</label>
				)}
				{files.map(([path, letter]) => {
					const clean = path.replace(/\/$/, "");
					const name = clean.split("/").at(-1) ?? clean;
					return (
						<div key={path} className="group flex items-center gap-2 px-3 py-0.5 text-[12.5px] hover:bg-white/[0.03]">
							<input
								type="checkbox"
								checked={!!ticked[path]}
								onChange={(event) => setTicked({ ...ticked, [path]: event.target.checked })}
								className="accent-[#e8002d]"
								aria-label={`Include ${path}`}
							/>
							<button
								type="button"
								disabled={path.endsWith("/")}
								onClick={() => void useEditor.getState().open(workspace.id, clean, { diff: letter === "M" || letter === "R" })}
								className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
								title={path}
							>
								<FileIcon name={name} kind={path.endsWith("/") ? "dir" : "file"} />
								<span className="truncate" style={{ color: GIT_COLORS[letter] }}>{name}</span>
								<span className="truncate font-mono text-[10px] text-muted">{clean.slice(0, clean.length - name.length)}</span>
							</button>
							<span className="font-mono text-[10px]" style={{ color: GIT_COLORS[letter] }}>{letter}</span>
						</div>
					);
				})}
			</div>
		</section>
	);
}
