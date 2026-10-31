import { describe, expect, test } from "vitest";
import { createGate, keyDirection, mouseDirection, parseNavArea, routeNav } from "./side-nav.ts";

describe("mouseDirection", () => {
	test("button 3 is back, 4 is forward, others nothing", () => {
		expect(mouseDirection(3)).toBe("back");
		expect(mouseDirection(4)).toBe("forward");
		expect(mouseDirection(0)).toBeNull();
		expect(mouseDirection(1)).toBeNull();
		expect(mouseDirection(2)).toBeNull();
	});
});

describe("keyDirection", () => {
	const key = (over: Partial<Parameters<typeof keyDirection>[0]>) => ({ key: "ArrowLeft", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...over });
	test("Alt+Left and Alt+Right", () => {
		expect(keyDirection(key({}))).toBe("back");
		expect(keyDirection(key({ key: "ArrowRight" }))).toBe("forward");
	});
	test("other combinations are left alone", () => {
		expect(keyDirection(key({ altKey: false }))).toBeNull();
		expect(keyDirection(key({ ctrlKey: true }))).toBeNull();
		expect(keyDirection(key({ shiftKey: true }))).toBeNull();
		expect(keyDirection(key({ key: "ArrowUp" }))).toBeNull();
	});
});

describe("parseNavArea / routeNav", () => {
	test("known areas parse; anything else is the app", () => {
		expect(parseNavArea("browser")).toBe("browser");
		expect(parseNavArea("brain")).toBe("brain");
		expect(parseNavArea("editor")).toBe("editor");
		expect(parseNavArea(null)).toBe("app");
		expect(parseNavArea("nonsense")).toBe("app");
	});
	test("the pointer's area wins, then the focused one, then the app", () => {
		expect(routeNav("brain", "editor")).toBe("brain");
		expect(routeNav("app", "editor")).toBe("editor");
		expect(routeNav("app", "app")).toBe("app");
	});
});

describe("createGate", () => {
	test("a second trigger of the same direction inside the window is dropped", () => {
		const gate = createGate(300);
		expect(gate.allow("back", 1000)).toBe(true);
		expect(gate.allow("back", 1100)).toBe(false);
		expect(gate.allow("back", 1301)).toBe(true);
	});
	test("another direction is not blocked", () => {
		const gate = createGate(300);
		gate.allow("back", 1000);
		expect(gate.allow("forward", 1050)).toBe(true);
	});
});
