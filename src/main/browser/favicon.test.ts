import { describe, expect, test } from "vitest";
import { fetchIcon, iconType, inlineIcon } from "./favicon.ts";

const respond = (body: Uint8Array<ArrayBuffer>, contentType: string, ok = true) => async (): Promise<Response> =>
	new Response(body, { status: ok ? 200 : 404, headers: { "content-type": contentType } });

describe("inlineIcon", () => {
	test("inline images pass, other data: and urls do not", () => {
		expect(inlineIcon("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
		expect(inlineIcon("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
		expect(inlineIcon("https://a.com/favicon.ico")).toBeNull();
	});
});

describe("iconType", () => {
	test("only image types, parameters ignored", () => {
		expect(iconType("image/png; charset=binary")).toBe("image/png");
		expect(iconType("text/html")).toBeNull();
		expect(iconType(null)).toBeNull();
	});
});

describe("fetchIcon", () => {
	test("a small image becomes a data url", async () => {
		expect(await fetchIcon("https://a.com/f.png", respond(new Uint8Array([1, 2, 3]), "image/png"))).toBe("data:image/png;base64,AQID");
	});
	test("not an image, too big, an error or another scheme: nothing", async () => {
		expect(await fetchIcon("https://a.com/f", respond(new Uint8Array([1]), "text/html"))).toBeNull();
		expect(await fetchIcon("https://a.com/f", respond(new Uint8Array(200_000), "image/png"))).toBeNull();
		expect(await fetchIcon("https://a.com/f", respond(new Uint8Array([1]), "image/png", false))).toBeNull();
		expect(await fetchIcon("https://a.com/f", async () => Promise.reject(new Error("offline")))).toBeNull();
		let called = false;
		expect(
			await fetchIcon("file://host/share/x.ico", async () => {
				called = true;
				return new Response("");
			}),
		).toBeNull();
		expect(called).toBe(false);
	});
});
