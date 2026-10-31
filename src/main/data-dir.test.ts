import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { dataDirFor } from "./data-dir.ts";

describe("dataDirFor", () => {
	const appData = join("C:", "Users", "x", "AppData", "Roaming");
	test("keeps the folder the app already has, whatever the product is called now", () => {
		expect(dataDirFor(appData, (p) => p === join(appData, "TeezAI"))).toBe(join(appData, "TeezAI"));
		expect(dataDirFor(appData, (p) => p === join(appData, "teezai"))).toBe(join(appData, "teezai"));
	});
	test("a fresh install uses the same name, so every machine agrees", () => {
		expect(dataDirFor(appData, () => false)).toBe(join(appData, "TeezAI"));
	});
});
