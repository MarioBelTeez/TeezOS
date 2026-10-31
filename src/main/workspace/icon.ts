import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveInsideReal } from "./guard.ts";

/**
 * A pinned folder's logo, the way Vercel shows each project's: a picked image
 * first, then the usual favicon and logo files, then the favicon the site's own
 * HTML links. Nothing found means the tile keeps its initials.
 *
 * Every candidate goes through the path guard, so a link like "../../x.png"
 * or a symlink cannot read outside the folder.
 */

export type WorkspaceIcon = { readonly dataUrl: string; readonly source: string };

export const MAX_ICON_BYTES = 512 * 1024;

const MIME: Readonly<Record<string, string>> = {
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

/** In order of preference: vector first, then the files frameworks and Electron apps use. */
const KNOWN = [
	"favicon.svg",
	"public/favicon.svg",
	"src/favicon.svg",
	"static/favicon.svg",
	"app/icon.svg",
	"src/app/icon.svg",
	"logo.svg",
	"public/logo.svg",
	"src/assets/logo.svg",
	"assets/logo.svg",
	"favicon.png",
	"public/favicon.png",
	"static/favicon.png",
	"app/icon.png",
	"src/app/icon.png",
	"build/icon.png",
	"resources/icon.png",
	"icon.png",
	"public/apple-touch-icon.png",
	"apple-touch-icon.png",
	"favicon.ico",
	"public/favicon.ico",
	"static/favicon.ico",
	"app/favicon.ico",
	"src/app/favicon.ico",
];

/** Pages whose <link rel="icon"> names the favicon. */
const PAGES = ["index.html", "src/index.html", "public/index.html", "src/layout.html", "layout.html"];
/** Where a root-relative href ("/x.png") can live before a build copies it. */
const WEB_ROOTS = ["", "public", "src", "static"];

/** The hrefs of a page's icon links: rel="icon" and "shortcut icon" first, touch icons last; remote ones skipped. */
export function findIconLinks(html: string): string[] {
	const primary: string[] = [];
	const touch: string[] = [];
	for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
		const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
		const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim() ?? "";
		if (!rel.split(/\s+/).some((word) => word === "icon" || word === "apple-touch-icon") || !href) continue;
		if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) continue;
		const clean = href.split(/[?#]/)[0] ?? "";
		if (!clean) continue;
		(rel.includes("apple-touch-icon") ? touch : primary).push(clean);
	}
	return [...primary, ...touch];
}

async function load(file: string, source: string): Promise<WorkspaceIcon | null> {
	const mime = MIME[path.extname(file).toLowerCase()];
	if (!mime) return null;
	try {
		const info = await stat(file);
		if (!info.isFile() || info.size === 0 || info.size > MAX_ICON_BYTES) return null;
		return { dataUrl: `data:${mime};base64,${(await readFile(file)).toString("base64")}`, source };
	} catch {
		return null;
	}
}

async function fromFolder(root: string, relative: string): Promise<WorkspaceIcon | null> {
	const guarded = resolveInsideReal(root, relative);
	return guarded.ok ? load(guarded.path, relative) : null;
}

/** `custom` is the image the user picked for this folder (kept in the app's data folder), or null. */
export async function findWorkspaceIcon(root: string, custom: string | null): Promise<WorkspaceIcon | null> {
	if (custom) {
		const picked = await load(custom, "custom");
		if (picked) return picked;
	}
	for (const relative of KNOWN) {
		const icon = await fromFolder(root, relative);
		if (icon) return icon;
	}
	for (const page of PAGES) {
		const guarded = resolveInsideReal(root, page);
		if (!guarded.ok) continue;
		let html: string;
		try {
			html = (await readFile(guarded.path, "utf8")).slice(0, 200_000);
		} catch {
			continue;
		}
		const pageDir = path.posix.dirname(page) === "." ? "" : path.posix.dirname(page);
		for (const href of findIconLinks(html)) {
			const candidates = href.startsWith("/")
				? WEB_ROOTS.map((base) => path.posix.join(base, href.slice(1)))
				: [path.posix.join(pageDir, href)];
			for (const candidate of candidates) {
				const icon = await fromFolder(root, candidate);
				if (icon) return icon;
			}
		}
	}
	return null;
}
