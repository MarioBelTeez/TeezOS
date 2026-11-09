import { execFile } from "node:child_process";
import path from "node:path";
import { normaliseAgyUsage, type AgyUsage } from "../../shared/usage.ts";

/**
 * Where Antigravity's CLI lives, and which models it offers.
 *
 * The installer puts it in %LOCALAPPDATA%\agy\bin (not always on PATH for
 * GUI apps), so that is checked before PATH. Models come from `agy models`,
 * read once per run of the app — they change with Antigravity releases, not
 * between messages.
 */

export type AgyModel = { readonly id: string; readonly label: string };

export function resolveAgy(deps: {
	readonly platform: NodeJS.Platform;
	readonly env: NodeJS.ProcessEnv;
	readonly home: string;
	readonly pathEntries: readonly string[];
	readonly isFile: (file: string) => boolean;
}): string | null {
	const windows = deps.platform === "win32";
	const api = windows ? path.win32 : path.posix;
	const exe = windows ? "agy.exe" : "agy";
	const candidates = [
		deps.env["TEEZAI_AGY_PATH"],
		windows ? api.join(deps.env["LOCALAPPDATA"] ?? api.join(deps.home, "AppData", "Local"), "agy", "bin", exe) : undefined,
		windows ? undefined : api.join(deps.home, ".local", "bin", exe),
		...deps.pathEntries.map((dir) => api.join(dir, exe)),
	];
	for (const candidate of candidates) {
		if (candidate && deps.isFile(candidate)) return candidate;
	}
	return null;
}

/** `agy models` prints "id<TAB>Label" per line after a "Fetching…" banner. */
export function parseModels(output: string): AgyModel[] {
	const models: AgyModel[] = [];
	for (const line of output.split(/\r?\n/)) {
		const [id, label] = line.split("\t");
		if (!id || !label || /\s/.test(id.trim())) continue;
		models.push({ id: id.trim(), label: label.trim() });
	}
	return models;
}

let cached: Promise<AgyModel[]> | null = null;

export function listModels(agyPath: string): Promise<AgyModel[]> {
	cached ??= new Promise((resolve) => {
		execFile(agyPath, ["models"], { timeout: 30_000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
			const models = error ? [] : parseModels(stdout);
			if (error || models.length === 0) cached = null; // try again next time rather than caching a failure or an unauthenticated empty list
			resolve(models);
		});
	});
	return cached;
}

export function fetchAgyUsage(agyPath: string): Promise<AgyUsage | null> {
	return new Promise((resolve) => {
		execFile(
			agyPath,
			["-p", "/usage", "--output-format", "json"],
			{ timeout: 20_000, windowsHide: true, encoding: "utf8" },
			(error, stdout) => {
				if (error || !stdout) {
					resolve(null);
					return;
				}
				try {
					resolve(normaliseAgyUsage(JSON.parse(stdout.trim())));
				} catch {
					resolve(null);
				}
			},
		);
	});
}
