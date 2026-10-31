import { describe, expect, test } from "vitest";
import { isSessionId, remoteControlCommand } from "./remote.ts";

const ID = "54856238-9718-4a1c-a6a4-220741190dd2";

describe("isSessionId", () => {
	test("accepts a Claude session id, nothing else", () => {
		expect(isSessionId(ID)).toBe(true);
		expect(isSessionId(ID.toUpperCase())).toBe(true);
		expect(isSessionId(`${ID}; rm -rf /`)).toBe(false);
		expect(isSessionId("")).toBe(false);
		expect(isSessionId(42)).toBe(false);
	});
});

describe("remoteControlCommand", () => {
	test("server mode: new sessions from the phone, in the workspace folder", () => {
		expect(remoteControlCommand()).toBe("claude remote-control --name TeezOS");
	});

	test("a chat handed to the phone resumes that session with Remote Control on", () => {
		expect(remoteControlCommand(ID)).toBe(`claude --resume ${ID} --remote-control TeezOS`);
	});

	test("anything that is not a session id is refused", () => {
		expect(() => remoteControlCommand("x; calc")).toThrow(/session id/);
	});
});
