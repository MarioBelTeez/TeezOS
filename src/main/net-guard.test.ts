import { describe, expect, test } from "vitest";
import { isNetworkFileUrl } from "./net-guard.ts";

describe("isNetworkFileUrl", () => {
	test.each([
		"file://attacker.example/share/x.png",
		"file:////attacker.example/share/x.png",
		"FILE://10.0.0.5/c$/x",
		"file://localhost/C:/Windows/win.ini",
	])("refuses %s", (url) => {
		expect(isNetworkFileUrl(url)).toBe(true);
	});

	test.each([
		"file:///C:/Users/user/AppData/Local/Programs/teezai/resources/app.asar/out/renderer/index.html",
		"file:///home/user/teezai/out/renderer/assets/index.js",
		"https://api.github.com/",
		"data:image/png;base64,AAAA",
	])("lets %s through", (url) => {
		expect(isNetworkFileUrl(url)).toBe(false);
	});
});
