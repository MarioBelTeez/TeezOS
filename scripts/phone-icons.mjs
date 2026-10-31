// Makes the phone app's icons from build/icon.png with nothing but node:zlib:
// 512 and 192 for the manifest, and a 180 apple-touch-icon flattened onto the
// app's background (iOS draws transparency as black anyway). The source must
// be an 8-bit RGBA, non-interlaced PNG (it is). Run: node scripts/phone-icons.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const root = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SOURCE = join(root, "build", "icon.png");
const OUT = join(root, "phone", "app", "public", "icons");
const BACKGROUND = [0x0b, 0x07, 0x08];

function readPng(file) {
	const data = readFileSync(file);
	let offset = 8;
	let width = 0;
	let height = 0;
	const idat = [];
	while (offset < data.length) {
		const length = data.readUInt32BE(offset);
		const type = data.toString("latin1", offset + 4, offset + 8);
		const body = data.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error("need an 8-bit RGBA, non-interlaced PNG");
		} else if (type === "IDAT") idat.push(body);
		offset += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * 4;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y += 1) {
		const filter = raw[y * (stride + 1)];
		for (let x = 0; x < stride; x += 1) {
			const value = raw[y * (stride + 1) + 1 + x];
			const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
			const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
			const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
			let predicted = 0;
			if (filter === 1) predicted = left;
			else if (filter === 2) predicted = up;
			else if (filter === 3) predicted = (left + up) >> 1;
			else if (filter === 4) {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
			}
			pixels[y * stride + x] = (value + predicted) & 0xff;
		}
	}
	return { width, height, pixels };
}

/** Area-average downscale, in premultiplied alpha so edges do not darken. */
function resize(image, size) {
	const out = Buffer.alloc(size * size * 4);
	const scale = image.width / size;
	for (let oy = 0; oy < size; oy += 1) {
		for (let ox = 0; ox < size; ox += 1) {
			const x0 = ox * scale;
			const y0 = oy * scale;
			let r = 0, g = 0, b = 0, a = 0, weight = 0;
			for (let sy = Math.floor(y0); sy < Math.ceil(y0 + scale); sy += 1) {
				const wy = Math.min(sy + 1, y0 + scale) - Math.max(sy, y0);
				for (let sx = Math.floor(x0); sx < Math.ceil(x0 + scale); sx += 1) {
					const w = wy * (Math.min(sx + 1, x0 + scale) - Math.max(sx, x0));
					const i = (sy * image.width + sx) * 4;
					const alpha = image.pixels[i + 3] / 255;
					r += image.pixels[i] * alpha * w;
					g += image.pixels[i + 1] * alpha * w;
					b += image.pixels[i + 2] * alpha * w;
					a += alpha * w;
					weight += w;
				}
			}
			const o = (oy * size + ox) * 4;
			out[o] = a > 0 ? Math.round(r / a) : 0;
			out[o + 1] = a > 0 ? Math.round(g / a) : 0;
			out[o + 2] = a > 0 ? Math.round(b / a) : 0;
			out[o + 3] = Math.round((a / weight) * 255);
		}
	}
	return { width: size, height: size, pixels: out };
}

function flatten(image, [br, bg, bb]) {
	const out = Buffer.from(image.pixels);
	for (let i = 0; i < out.length; i += 4) {
		const alpha = out[i + 3] / 255;
		out[i] = Math.round(out[i] * alpha + br * (1 - alpha));
		out[i + 1] = Math.round(out[i + 1] * alpha + bg * (1 - alpha));
		out[i + 2] = Math.round(out[i + 2] * alpha + bb * (1 - alpha));
		out[i + 3] = 255;
	}
	return { ...image, pixels: out };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
	return Buffer.concat([head, body, crc]);
}
function writePng(file, image) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(image.width, 0);
	ihdr.writeUInt32BE(image.height, 4);
	ihdr.set([8, 6, 0, 0, 0], 8);
	const stride = image.width * 4;
	const raw = Buffer.alloc((stride + 1) * image.height);
	for (let y = 0; y < image.height; y += 1) image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	writeFileSync(file, Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

const source = readPng(SOURCE);
mkdirSync(OUT, { recursive: true });
writePng(join(OUT, "icon-512.png"), source.width === 512 ? source : resize(source, 512));
writePng(join(OUT, "icon-192.png"), resize(source, 192));
writePng(join(OUT, "apple-touch-icon.png"), flatten(resize(source, 180), BACKGROUND));
console.log(`icons written to ${OUT}`);
