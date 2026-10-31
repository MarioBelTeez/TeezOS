import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTURE_WIDTHS, captureConfig, captureHeight, parseCaptureView, parseCaptureWidths } from "./capture-config.ts";

describe("parseCaptureWidths", () => {
	it("defaults to 1440 and 2560 when unset or empty", () => {
		expect(parseCaptureWidths(undefined)).toEqual([1440, 2560]);
		expect(parseCaptureWidths("")).toEqual(DEFAULT_CAPTURE_WIDTHS);
	});

	it("reads a comma list, trimming spaces", () => {
		expect(parseCaptureWidths(" 1920 , 2560")).toEqual([1920, 2560]);
	});

	it("drops non-numbers, out-of-range widths and duplicates", () => {
		expect(parseCaptureWidths("abc,1440,12.5,-3,320,99999,1440,3840")).toEqual([1440, 3840]);
	});

	it("falls back to the defaults when nothing is valid", () => {
		expect(parseCaptureWidths("wide,0")).toEqual(DEFAULT_CAPTURE_WIDTHS);
	});
});

describe("captureHeight", () => {
	it("is 16:9, rounded", () => {
		expect(captureHeight(1440)).toBe(810);
		expect(captureHeight(2560)).toBe(1440);
		expect(captureHeight(1366)).toBe(768);
	});
});

describe("parseCaptureView", () => {
	it("accepts a view id or settings, case-insensitively", () => {
		expect(parseCaptureView("brain")).toBe("brain");
		expect(parseCaptureView(" Settings ")).toBe("settings");
	});

	it("accepts chat for the chat panel brought to the front", () => {
		expect(parseCaptureView("chat")).toBe("chat");
		expect(parseCaptureView(" Chat ")).toBe("chat");
	});

	it("accepts brain:graph for the Brain view in graph mode", () => {
		expect(parseCaptureView("brain:graph")).toBe("brain:graph");
		expect(parseCaptureView("brain:note")).toBeNull();
	});
	it("accepts a settings page as settings:<page>", () => {
		expect(parseCaptureView("settings:presets")).toBe("settings:presets");
		expect(parseCaptureView("Settings:Editor")).toBe("settings:editor");
		expect(parseCaptureView("settings:../x")).toBeNull();
		expect(parseCaptureView("settings:")).toBeNull();
	});

	it("ignores unknown or empty values", () => {
		expect(parseCaptureView("desk")).toBeNull();
		expect(parseCaptureView("")).toBeNull();
		expect(parseCaptureView(undefined)).toBeNull();
	});
});

describe("captureConfig", () => {
	it("is off in a packaged build whatever the environment says", () => {
		expect(captureConfig({ TEEZAI_CAPTURE: "C:/qa" }, true)).toBeNull();
	});

	it("is off without a folder", () => {
		expect(captureConfig({ TEEZAI_CAPTURE: "  " }, false)).toBeNull();
		expect(captureConfig({}, false)).toBeNull();
	});

	it("reads folder, widths, quit and view", () => {
		expect(
			captureConfig({ TEEZAI_CAPTURE: "C:/qa", TEEZAI_CAPTURE_WIDTHS: "1920", TEEZAI_CAPTURE_QUIT: "1", TEEZAI_CAPTURE_VIEW: "feed" }, false),
		).toEqual({ folder: "C:/qa", widths: [1920], quit: true, view: "feed" });
		expect(captureConfig({ TEEZAI_CAPTURE: "C:/qa", TEEZAI_CAPTURE_QUIT: "yes" }, false)).toEqual({
			folder: "C:/qa",
			widths: [1440, 2560],
			quit: false,
			view: null,
		});
	});
});
