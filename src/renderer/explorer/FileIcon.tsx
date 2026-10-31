import {
	Braces,
	File,
	FileCode2,
	FileCog,
	FileImage,
	FileLock2,
	FileTerminal,
	FileText,
	FileType2,
	Folder,
	FolderGit2,
	FolderOpen,
	Palette,
	Package,
	type LucideIcon,
} from "lucide-react";

/** One icon and tint per kind of file, so a folder reads at a glance. */

type IconSpec = { readonly icon: LucideIcon; readonly color: string };

const BY_NAME: Readonly<Record<string, IconSpec>> = {
	"package.json": { icon: Package, color: "#e8002d" },
	"package-lock.json": { icon: FileLock2, color: "#6b5b62" },
	".gitignore": { icon: FileCog, color: "#6b5b62" },
	".env": { icon: FileLock2, color: "#f5a524" },
	"claude.md": { icon: FileText, color: "#ff8a5c" },
	"gemini.md": { icon: FileText, color: "#75beff" },
	"agents.md": { icon: FileText, color: "#c586c0" },
	dockerfile: { icon: FileCog, color: "#75beff" },
};

const BY_EXT: Readonly<Record<string, IconSpec>> = {
	ts: { icon: FileCode2, color: "#4f9dff" },
	tsx: { icon: FileCode2, color: "#4f9dff" },
	js: { icon: FileCode2, color: "#f5d24a" },
	jsx: { icon: FileCode2, color: "#f5d24a" },
	mjs: { icon: FileCode2, color: "#f5d24a" },
	cjs: { icon: FileCode2, color: "#f5d24a" },
	json: { icon: Braces, color: "#f5a524" },
	md: { icon: FileText, color: "#e9b8c4" },
	mdx: { icon: FileText, color: "#e9b8c4" },
	css: { icon: Palette, color: "#c586c0" },
	scss: { icon: Palette, color: "#c586c0" },
	html: { icon: FileCode2, color: "#ff6b4a" },
	py: { icon: FileCode2, color: "#73c991" },
	sh: { icon: FileTerminal, color: "#73c991" },
	ps1: { icon: FileTerminal, color: "#75beff" },
	yml: { icon: FileCog, color: "#e2c08d" },
	yaml: { icon: FileCog, color: "#e2c08d" },
	toml: { icon: FileCog, color: "#e2c08d" },
	png: { icon: FileImage, color: "#73c991" },
	jpg: { icon: FileImage, color: "#73c991" },
	jpeg: { icon: FileImage, color: "#73c991" },
	webp: { icon: FileImage, color: "#73c991" },
	gif: { icon: FileImage, color: "#73c991" },
	svg: { icon: FileImage, color: "#f5a524" },
	ico: { icon: FileImage, color: "#73c991" },
	woff2: { icon: FileType2, color: "#9c8a92" },
	ttf: { icon: FileType2, color: "#9c8a92" },
	canvas: { icon: FileCog, color: "#c586c0" },
	base: { icon: FileCog, color: "#c586c0" },
	lock: { icon: FileLock2, color: "#6b5b62" },
	log: { icon: FileText, color: "#6b5b62" },
	txt: { icon: FileText, color: "#9c8a92" },
};

export function iconFor(name: string, kind: "dir" | "file", open = false): IconSpec {
	if (kind === "dir") {
		if (name === ".github" || name === ".git") return { icon: FolderGit2, color: "#9c8a92" };
		return { icon: open ? FolderOpen : Folder, color: open ? "#e8002d" : "#9c8a92" };
	}
	const lower = name.toLowerCase();
	const named = BY_NAME[lower];
	if (named) return named;
	const dot = lower.lastIndexOf(".");
	const ext = dot === -1 ? "" : lower.slice(dot + 1);
	return BY_EXT[ext] ?? { icon: File, color: "#9c8a92" };
}

export function FileIcon({
	name,
	kind = "file",
	open = false,
	size = 14,
}: {
	readonly name: string;
	readonly kind?: "dir" | "file";
	readonly open?: boolean;
	readonly size?: number;
}): React.JSX.Element {
	const { icon: Icon, color } = iconFor(name, kind, open);
	return <Icon size={size} color={color} strokeWidth={1.75} className="shrink-0" aria-hidden />;
}

/** VS Code's colours for the git letters, kept so the meaning carries over. */
export const GIT_COLORS: Readonly<Record<string, string>> = {
	M: "#e2c08d",
	A: "#73c991",
	U: "#73c991",
	D: "#ff4d6a",
	R: "#75beff",
	C: "#c586c0",
};
