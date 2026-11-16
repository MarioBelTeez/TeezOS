import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatImage, ImageType } from "../../shared/images.ts";

const EXTENSIONS: Readonly<Record<ImageType, string>> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

export type WrittenImages = {
	readonly dir: string;
	readonly paths: readonly string[];
	cleanup(): void;
};

/**
 * Writes pasted/uploaded images to a short-lived temp directory so CLI agents
 * without inline multimodal stdin (`agy`, headless `claude -p`) can inspect
 * them via `--add-dir` and their file-read tool.
 */
export function writeTurnImages(images: readonly ChatImage[]): WrittenImages | null {
	if (images.length === 0) return null;
	const dir = mkdtempSync(join(tmpdir(), "teezos-img-"));
	try {
		chmodSync(dir, 0o755);
	} catch {
		// Best-effort on platforms where POSIX modes do not apply.
	}
	const paths: string[] = [];
	for (let i = 0; i < images.length; i += 1) {
		const image = images[i]!;
		const ext = EXTENSIONS[image.mediaType] ?? ".png";
		const file = join(dir, `image-${i + 1}${ext}`);
		writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o644 });
		try {
			chmodSync(file, 0o644);
		} catch {
			// Best-effort.
		}
		paths.push(file);
	}
	return {
		dir,
		paths,
		cleanup: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup.
			}
		},
	};
}

export function appendAttachedImages(text: string, paths: readonly string[], toolHint = "read_file/view_file"): string {
	if (paths.length === 0) return text;
	const note = `[Attached image(s) — inspect with ${toolHint}:\n${paths.map((p) => `- ${p}`).join("\n")}]`;
	return text.trim() ? `${text}\n\n${note}` : `Inspect the attached image(s).\n\n${note}`;
}
