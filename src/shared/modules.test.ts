import { describe, expect, test } from "vitest";
import { DEFAULT_MODULES, isModuleEnabled, mergeModules, normalizeModules } from "./modules.ts";

describe("normalizeModules", () => {
	test("garbage gives the defaults", () => {
		expect(normalizeModules(null, [])).toEqual(DEFAULT_MODULES);
		expect(normalizeModules("x", [])).toEqual(DEFAULT_MODULES);
	});
	test("a 0.2.6 file: hidden views become disabled modules", () => {
		const m = normalizeModules(undefined, ["brain", "server"]);
		expect(m.brain.enabled).toBe(false);
		expect(m.server.enabled).toBe(false);
		expect(m.automations.enabled).toBe(true);
	});
	test("explicit modules win over the legacy list", () => {
		expect(normalizeModules({ brain: { enabled: true } }, ["brain"]).brain.enabled).toBe(true);
	});
	test("out-of-range numbers clamp, bad enums fall back", () => {
		const m = normalizeModules({ editor: { fontSize: 99, tabSize: 3 }, chat: { textSize: "xl" }, brain: { repel: -5, labels: "sometimes" } }, []);
		expect(m.editor.fontSize).toBe(24);
		expect(m.editor.tabSize).toBe(2);
		expect(m.chat.textSize).toBe("m");
		expect(m.brain.repel).toBe(30);
		expect(m.brain.labels).toBe("zoom");
	});
	test("chat and editor cannot be disabled", () => {
		const m = normalizeModules({ chat: { enabled: false }, editor: { enabled: false } }, []);
		expect(m.chat.enabled).toBe(true);
		expect(m.editor.enabled).toBe(true);
	});
	test("browser pins: only http(s), trimmed, at most 12", () => {
		const pins = [{ title: " Mail ", url: "https://privateemail.com" }, { title: "bad", url: "javascript:alert(1)" }, ...Array.from({ length: 20 }, (_, i) => ({ title: `p${i}`, url: `https://x${i}.com` }))];
		const m = normalizeModules({ browser: { pins, home: "file:///C:/" } }, []);
		expect(m.browser.pins[0]).toEqual({ title: "Mail", url: "https://privateemail.com" });
		expect(m.browser.pins.some((p) => p.url.startsWith("javascript"))).toBe(false);
		expect(m.browser.pins.length).toBe(12);
		expect(m.browser.home).toBe("https://duckduckgo.com");
	});
	test("browser pins and home must parse as http(s) urls", () => {
		const pins = [
			{ title: "ok", url: "https://ok.com" },
			{ title: "prefix only", url: "httpfoo" },
			{ title: "no host", url: "https://" },
			{ title: "ftp", url: "ftp://x.com" },
			{ title: "", url: "https://untitled.com" },
			{ title: "   ", url: "https://blank.com" },
			{ title: "long", url: `https://long.com/${"x".repeat(2100)}` },
		];
		const m = normalizeModules({ browser: { pins, home: "httpx://nope" } }, []);
		expect(m.browser.pins).toEqual([{ title: "ok", url: "https://ok.com" }]);
		expect(m.browser.home).toBe("https://duckduckgo.com");
		expect(normalizeModules({ browser: { home: " https://start.example/ " } }, []).browser.home).toBe("https://start.example/");
		expect(normalizeModules({ browser: { home: `https://a.com/${"x".repeat(2100)}` } }, []).browser.home).toBe("https://duckduckgo.com");
	});
	test("isModuleEnabled", () => {
		expect(isModuleEnabled(normalizeModules(undefined, ["feed"]), "feed")).toBe(false);
	});

	test("fractional fields keep their fraction, integer fields round", () => {
		expect(DEFAULT_MODULES.terminal.fontSize).toBe(12.5);
		const m = normalizeModules({ terminal: { fontSize: 12.5 }, brain: { gravity: 0.3, repel: 100.6 }, editor: { fontSize: 13.4 } }, []);
		expect(m.terminal.fontSize).toBe(12.5);
		expect(m.brain.gravity).toBe(0.3);
		expect(m.brain.repel).toBe(101);
		expect(m.editor.fontSize).toBe(13);
		expect(normalizeModules({ brain: { gravity: 9 }, terminal: { fontSize: 1 } }, []).brain.gravity).toBe(0.5);
	});
});

describe("mergeModules", () => {
	test("merges per module and ignores unknown ids", () => {
		const m = mergeModules(DEFAULT_MODULES, { brain: { repel: 400 }, nope: { x: 1 } });
		expect(m.brain.repel).toBe(400);
		expect(m.brain.labels).toBe("zoom");
		expect("nope" in m).toBe(false);
	});
});

describe("chat.autoContinue", () => {
	test("is on by default and keeps an explicit off", () => {
		expect(normalizeModules({}, []).chat.autoContinue).toBe(true);
		expect(normalizeModules({ chat: { autoContinue: false } }, []).chat.autoContinue).toBe(false);
		expect(normalizeModules({ chat: { autoContinue: "no" } }, []).chat.autoContinue).toBe(true);
	});
});
