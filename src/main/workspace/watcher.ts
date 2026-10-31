import { watch, type FSWatcher } from "node:fs";

/**
 * Tells the window when something on disk changed, so the tree and the git
 * badges follow edits made by Claude, the terminal or any other program.
 *
 * Bursts are folded together: an `npm install` or a checkout touches thousands
 * of files, and the tree only needs to know which folders to re-read. Changes
 * inside `.git` alter no folder the user sees, only the status.
 */

export type FsChange = {
	/** Workspace-relative folders whose listing may have changed ("" is the root). */
	readonly dirs: readonly string[];
	/** True when git status should be read again. */
	readonly git: boolean;
};

const DEBOUNCE_MS = 250;

export function parentOf(relative: string): string {
	const normal = relative.replace(/\\/g, "/");
	const slash = normal.lastIndexOf("/");
	return slash === -1 ? "" : normal.slice(0, slash);
}

export class WorkspaceWatcher {
	#watcher: FSWatcher | null = null;
	#timer: NodeJS.Timeout | null = null;
	#dirs = new Set<string>();
	#git = false;

	constructor(
		readonly root: string,
		readonly onChange: (change: FsChange) => void,
	) {
		try {
			this.#watcher = watch(root, { recursive: true }, (_event, filename) => {
				this.#record(typeof filename === "string" ? filename : "");
			});
			// A watcher on a folder that disappears errors; the tree still works
			// on demand, it just stops refreshing by itself.
			this.#watcher.on("error", () => this.close());
		} catch {
			this.#watcher = null;
		}
	}

	get active(): boolean {
		return this.#watcher !== null;
	}

	#record(filename: string): void {
		const normal = filename.replace(/\\/g, "/");
		if (normal === ".git" || normal.startsWith(".git/")) {
			this.#git = true;
		} else {
			this.#dirs.add(parentOf(normal));
			// Any change in the working tree can change the status too.
			this.#git = true;
		}
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.#flush(), DEBOUNCE_MS);
	}

	#flush(): void {
		this.#timer = null;
		const change: FsChange = { dirs: [...this.#dirs], git: this.#git };
		this.#dirs = new Set();
		this.#git = false;
		this.onChange(change);
	}

	close(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.#watcher?.close();
		this.#watcher = null;
	}
}
