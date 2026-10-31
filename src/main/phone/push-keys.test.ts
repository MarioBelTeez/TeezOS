import { describe, expect, it, vi } from "vitest";
import { PHONE_KEYS_COMMAND, pushPhoneKeys } from "./push-keys.ts";

const COMMAND =
	"pct exec 104 -- sh -c 'umask 077 && cat > /etc/teez-phone/keys.json.tmp && chown teezphone:teezphone /etc/teez-phone/keys.json.tmp && mv /etc/teez-phone/keys.json.tmp /etc/teez-phone/keys.json'";

describe("pushPhoneKeys", () => {
	it("reads stdin with cat, never by reopening /dev/stdin", () => {
		// CT 104 is unprivileged: the pipe pct hands in belongs to the host's root,
		// so reopening /dev/stdin by path is refused ("install: cannot open
		// '/dev/stdin' for reading: Permission denied"). cat reads the open fd.
		expect(PHONE_KEYS_COMMAND).not.toContain("/dev/stdin");
		expect(PHONE_KEYS_COMMAND).toContain("cat > ");
	});

	it("sends the keys on stdin, never in the arguments", async () => {
		const ssh = vi.fn().mockResolvedValue({ ok: true, output: "" });
		const result = await pushPhoneKeys({ gemini: "AIza-secret-gemini-key", groq: "gsk_secretgroq" }, ssh);
		expect(result.ok).toBe(true);
		const [args, stdin] = ssh.mock.calls[0] as [readonly string[], string];
		expect(args).toContain(COMMAND);
		expect(args.join(" ")).not.toContain("secret");
		expect(JSON.parse(stdin)).toEqual({ gemini: "AIza-secret-gemini-key", groq: "gsk_secretgroq" });
		expect(result.message).not.toContain("secret");
	});

	it("only includes keys that are set", async () => {
		const ssh = vi.fn().mockResolvedValue({ ok: true, output: "" });
		await pushPhoneKeys({ groq: "gsk_x" }, ssh);
		expect(JSON.parse((ssh.mock.calls[0] as [unknown, string])[1])).toEqual({ groq: "gsk_x" });
	});

	it("does not connect when no key is saved", async () => {
		const ssh = vi.fn();
		const result = await pushPhoneKeys({}, ssh);
		expect(result).toEqual({ ok: false, message: "No Feed keys are saved on this PC." });
		expect(ssh).not.toHaveBeenCalled();
	});

	it("reports the server's error without echoing keys", async () => {
		const ssh = vi.fn().mockResolvedValue({ ok: false, output: "install: cannot create regular file: No such file or directory" });
		const result = await pushPhoneKeys({ groq: "gsk_x" }, ssh);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("No such file or directory");
	});
});
