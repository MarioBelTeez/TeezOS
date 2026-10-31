import { describe, expect, test } from "vitest";
import { ALIAS, PRIVILEGES, SETUP_SCRIPT, parseTokenOutput } from "./setup.ts";
import { normalizeFingerprint } from "./client.ts";

describe("Proxmox setup", () => {
	test("the role never grants user, config or guest creation rights", () => {
		for (const forbidden of ["User.Modify", "Permissions.Modify", "VM.Allocate", "VM.Config", "Sys.Modify", "Datastore.Allocate,", "Realm"]) {
			expect(PRIVILEGES).not.toContain(forbidden);
		}
	});

	test("SSH aliases cannot pose as options", () => {
		expect(ALIAS.test("pve")).toBe(true);
		expect(ALIAS.test("root@192.168.1.2")).toBe(true);
		expect(ALIAS.test("-oProxyCommand=calc")).toBe(false);
		expect(ALIAS.test("-Jhost")).toBe(false);
	});

	test("the role holds only what the Server view uses", () => {
		expect(PRIVILEGES).not.toContain("VM.Console");
		expect(PRIVILEGES).not.toContain("VM.Snapshot");
	});

	test("the token is never tied to root", () => {
		expect(SETUP_SCRIPT).not.toContain("root@pam");
		expect(SETUP_SCRIPT).toContain("teezai@pve");
	});

	test("reads pveum's JSON, ignoring anything printed before it", () => {
		const output = 'warning: something\n{"full-tokenid":"teezai@pve!app","info":{"privsep":"0"},"value":"0b1e-secret"}';
		expect(parseTokenOutput(output)).toEqual({ tokenId: "teezai@pve!app", secret: "0b1e-secret" });
		expect(() => parseTokenOutput('{"info":{}}')).toThrow();
	});

	test("fingerprints compare however they are written", () => {
		expect(normalizeFingerprint("C1:B6:12:F0")).toBe(normalizeFingerprint("c1b612f0"));
	});
});
