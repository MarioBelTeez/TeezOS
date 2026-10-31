import { describe, expect, test } from "vitest";
import { MAX_BASE64, MAX_IMAGES, sniffImageType, splitDataUrl, validateImages } from "./images.ts";

const b64 = (bytes: number[] | string): string =>
	btoa(typeof bytes === "string" ? bytes : String.fromCharCode(...bytes));

const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const GIF = b64("GIF89a\x01\x00\x01\x00");
const WEBP = b64("RIFF\x24\x00\x00\x00WEBPVP8 ");

describe("sniffImageType", () => {
	test.each([
		[PNG, "image/png"],
		[JPEG, "image/jpeg"],
		[GIF, "image/gif"],
		[WEBP, "image/webp"],
		[b64("<svg xmlns="), null],
		["!!!", null],
	])("%s is %s", (data, type) => {
		expect(sniffImageType(data)).toBe(type);
	});
});

describe("validateImages", () => {
	test("takes the type from the bytes, not the label", () => {
		expect(validateImages([{ mediaType: "image/png", data: JPEG }])).toEqual([{ mediaType: "image/jpeg", data: JPEG }]);
	});

	test("none at all is fine", () => {
		expect(validateImages(undefined)).toEqual([]);
		expect(validateImages([])).toEqual([]);
	});

	test.each([
		["too many", Array.from({ length: MAX_IMAGES + 1 }, () => ({ data: PNG }))],
		["not an image", [{ mediaType: "image/png", data: b64("<svg xmlns=") }]],
		["not base64", [{ mediaType: "image/png", data: "<script>" }]],
		["empty", [{ mediaType: "image/png", data: "" }]],
		["over the API's limit", [{ mediaType: "image/png", data: PNG + "A".repeat(MAX_BASE64) }]],
		["an item that is not an object", ["iVBOR"]],
		["not a list", "nope"],
	])("refuses %s", (_label, value) => {
		expect(validateImages(value)).toBeNull();
	});
});

describe("splitDataUrl", () => {
	test("splits what FileReader and canvas produce", () => {
		expect(splitDataUrl(`data:image/png;base64,${PNG}`)).toEqual({ mediaType: "image/png", data: PNG });
	});

	test("anything else comes back empty, so the bridge refuses it", () => {
		expect(splitDataUrl("https://example.com/x.png")).toEqual({ mediaType: "", data: "" });
	});
});
