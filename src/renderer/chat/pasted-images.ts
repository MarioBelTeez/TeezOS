import { MAX_BASE64, MAX_EDGE, splitDataUrl } from "../../shared/images.ts";

/**
 * A screenshot pasted into the composer, made ready to send: `url` is what
 * Claude gets (shrunk to the size it would scale to anyway, and under the
 * API's per-image limit), `thumb` is the small copy the chat keeps on screen.
 */
export type PastedImage = { readonly url: string; readonly thumb: string };

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const THUMB_EDGE = 320;

export async function prepareImage(file: File): Promise<PastedImage> {
	const bitmap = await createImageBitmap(file);
	try {
		const original = await readAsDataUrl(file);
		let url = original;
		if (Math.max(bitmap.width, bitmap.height) > MAX_EDGE || splitDataUrl(original).data.length > MAX_BASE64) {
			url = render(bitmap, MAX_EDGE, file.type === "image/png" ? "image/png" : "image/jpeg");
			if (splitDataUrl(url).data.length > MAX_BASE64) url = render(bitmap, MAX_EDGE, "image/jpeg", 0.85);
		}
		if (splitDataUrl(url).data.length > MAX_BASE64) throw new Error("still too large");
		return { url, thumb: render(bitmap, THUMB_EDGE, "image/webp", 0.8) };
	} finally {
		bitmap.close();
	}
}

function render(bitmap: ImageBitmap, edge: number, type: string, quality?: number): string {
	const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	const context = canvas.getContext("2d");
	if (!context) throw new Error("no 2d canvas");
	// JPEG has no transparency: give see-through pixels white rather than black.
	if (type === "image/jpeg") {
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, canvas.width, canvas.height);
	}
	context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL(type, quality);
}

function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("unreadable")));
		reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
		reader.readAsDataURL(file);
	});
}
