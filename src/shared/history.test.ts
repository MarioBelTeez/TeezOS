import { describe, expect, test } from "vitest";
import { createHistory } from "./history.ts";

describe("createHistory", () => {
	test("starts empty with nowhere to go", () => {
		const h = createHistory<string>();
		expect(h.current()).toBeUndefined();
		expect(h.canBack()).toBe(false);
		expect(h.canForward()).toBe(false);
		expect(h.back()).toBeUndefined();
		expect(h.forward()).toBeUndefined();
	});
	test("push, back and forward walk the entries", () => {
		const h = createHistory<string>();
		h.push("a");
		h.push("b");
		h.push("c");
		expect(h.current()).toBe("c");
		expect(h.back()).toBe("b");
		expect(h.back()).toBe("a");
		expect(h.canBack()).toBe(false);
		expect(h.back()).toBeUndefined();
		expect(h.forward()).toBe("b");
		expect(h.canForward()).toBe(true);
	});
	test("a consecutive duplicate is not pushed", () => {
		const h = createHistory<string>();
		h.push("a");
		h.push("a");
		h.push("b");
		h.push("b");
		expect(h.back()).toBe("a");
		expect(h.canBack()).toBe(false);
	});
	test("a new push after going back drops the forward entries", () => {
		const h = createHistory<string>();
		["a", "b", "c"].forEach((x) => h.push(x));
		h.back();
		h.push("d");
		expect(h.canForward()).toBe(false);
		expect(h.back()).toBe("b");
	});
	test("navigating does not push: re-pushing the entry arrived at keeps forward", () => {
		const h = createHistory<string>();
		["a", "b", "c"].forEach((x) => h.push(x));
		const arrived = h.back();
		h.push(arrived as string);
		expect(h.canForward()).toBe(true);
		expect(h.forward()).toBe("c");
	});
	test("keeps at most max entries, dropping the oldest", () => {
		const h = createHistory<number>(3);
		[1, 2, 3, 4, 5].forEach((x) => h.push(x));
		expect(h.back()).toBe(4);
		expect(h.back()).toBe(3);
		expect(h.canBack()).toBe(false);
	});
	test("defaults to 50", () => {
		const h = createHistory<number>();
		for (let i = 0; i < 80; i++) h.push(i);
		let steps = 0;
		while (h.back() !== undefined) steps++;
		expect(steps).toBe(49);
	});
	test("peek lets the caller skip entries that are gone", () => {
		const h = createHistory<string>();
		["a", "b", "c"].forEach((x) => h.push(x));
		expect(h.back((x) => x !== "b")).toBe("a");
		expect(h.current()).toBe("a");
		expect(h.back((x) => x !== "zzz")).toBeUndefined();
		expect(h.current()).toBe("a");
	});
});
