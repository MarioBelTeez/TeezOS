import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { scanVault, slugPath } from "./vault.ts";

/**
 * Search the vault the way the agents do: through QMD, the same index Claude's
 * hooks keep fresh. QMD is a Node program with native modules built for the
 * system's Node, so it runs under `node`, not under Electron — and directly,
 * never through `qmd.cmd` and a shell, so the query is never shell text.
 *
 * "Fast" is BM25 keyword search; "deep" is QMD's hybrid query (expansion and
 * reranking with local models — slower, better for questions). When QMD is
 * missing or fails, a plain substring search over the notes answers instead.
 */

export type BrainHit = {
	readonly path: string;
	readonly title: string;
	readonly snippet: string;
	readonly score: number;
	readonly line: number;
};

export function locateQmd(env: NodeJS.ProcessEnv = process.env): string | null {
	// On Linux and macOS, npm's global bin holds a symlink to the package's
	// script, wherever the prefix is (~/.npm-global, /usr/local, nvm…).
	if (process.platform !== "win32") {
		for (const dir of (env["PATH"] ?? "").split(path.delimiter).filter(Boolean)) {
			try {
				const real = realpathSync(path.join(dir, "qmd"));
				if (real.includes(`${path.sep}@tobilu${path.sep}qmd${path.sep}`)) return real;
			} catch {
				// not in this directory
			}
		}
	}
	const candidates = [
		env["TEEZAI_QMD_PATH"],
		env["APPDATA"] ? path.join(env["APPDATA"], "npm", "node_modules", "@tobilu", "qmd", "bin", "qmd") : undefined,
		"/usr/local/lib/node_modules/@tobilu/qmd/bin/qmd",
		"/usr/lib/node_modules/@tobilu/qmd/bin/qmd",
	];
	return candidates.find((c) => c && existsSync(c)) ?? null;
}

function qmdIndexName(vaultRoot: string): string {
	try {
		const manifest = JSON.parse(readFileSync(path.join(vaultRoot, "vault-manifest.json"), "utf8")) as { qmd_index?: unknown };
		if (typeof manifest.qmd_index === "string" && /^[\w.-]+$/.test(manifest.qmd_index)) return manifest.qmd_index;
	} catch {
		// no manifest: QMD's default index
	}
	return "index";
}

/** Strip QMD's `@@ -2,4 @@ (1 before, 9 after)` hunk header from a snippet. */
function cleanSnippet(snippet: string): string {
	return snippet.replace(/^@@[^\n]*\n/, "").replace(/\s+/g, " ").trim().slice(0, 280);
}

function runQmd(qmd: string, vaultRoot: string, args: readonly string[], timeout: number): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			process.platform === "win32" ? "node.exe" : "node",
			[qmd, "--index", qmdIndexName(vaultRoot), ...args],
			{ cwd: vaultRoot, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
			(error, stdout) => resolve(error ? null : stdout),
		);
	});
}

async function fallback(vaultRoot: string, query: string): Promise<BrainHit[]> {
	const needle = query.toLowerCase();
	const words = needle.split(/\s+/).filter(Boolean);
	const index = await scanVault(vaultRoot);
	const hits: BrainHit[] = [];
	for (const note of index.notes) {
		const haystack = `${note.title}\n${note.description}\n${note.tags.join(" ")}`.toLowerCase();
		const score = words.reduce((sum, word) => sum + (note.title.toLowerCase().includes(word) ? 3 : 0) + (haystack.includes(word) ? 1 : 0), 0);
		if (score > 0) hits.push({ path: note.path, title: note.title, snippet: note.description, score, line: 1 });
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, 30);
}

export async function searchBrain(vaultRoot: string, query: string, deep: boolean): Promise<{ hits: BrainHit[]; engine: string }> {
	const q = query.trim().slice(0, 300);
	if (!q) return { hits: [], engine: "none" };
	const qmd = locateQmd();
	if (qmd) {
		const raw = await runQmd(qmd, vaultRoot, deep ? ["query", q, "--json", "-n", "20"] : ["search", q, "--json", "-n", "30"], deep ? 120_000 : 20_000);
		if (raw) {
			try {
				const parsed = JSON.parse(raw.slice(raw.indexOf("["))) as { file?: string; title?: string; snippet?: string; score?: number; line?: number }[];
				const index = await scanVault(vaultRoot);
				const bySlug = new Map(index.notes.map((note) => [slugPath(note.path).toLowerCase(), note]));
				const hits: BrainHit[] = [];
				for (const item of parsed) {
					const slug = (item.file ?? "").replace(/^qmd:\/\/[^/]+\//, "").replace(/\?.*$/, "").toLowerCase();
					const note = bySlug.get(slug);
					if (!note) continue;
					hits.push({
						path: note.path,
						title: note.title,
						snippet: cleanSnippet(item.snippet ?? ""),
						score: item.score ?? 0,
						line: item.line ?? 1,
					});
				}
				return { hits, engine: deep ? "qmd query" : "qmd search" };
			} catch {
				// unexpected output: fall through
			}
		}
	}
	return { hits: await fallback(vaultRoot, q), engine: "titles" };
}
