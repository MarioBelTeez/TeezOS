import { describe, expect, test } from "vitest";
import { appTrail, deskEntry, recordDeskSwitch, viewEntry } from "./app-trail.ts";

describe("app trail", () => {
	test("desk switches record both desks; walking back and forward adds nothing", () => {
		// code -> desk A -> desk B, as switchDesk records it
		recordDeskSwitch("A", "B");
		expect(appTrail.current()).toBe(deskEntry("B"));
		// Back/Forward call switchDesk with record: false, so nothing is pushed.
		expect(appTrail.back()).toBe(deskEntry("A"));
		expect(appTrail.back()).toBe(viewEntry("code"));
		expect(appTrail.forward()).toBe(deskEntry("A"));
		expect(appTrail.forward()).toBe(deskEntry("B"));
		expect(appTrail.canForward()).toBe(false);
		expect(appTrail.back()).toBe(deskEntry("A"));
		expect(appTrail.canForward()).toBe(true);
	});
});
