import { spawn } from "node:child_process";

/**
 * Sends the Feed keys to the phone server over the SSH path the Server view
 * already uses (`ssh pve`). The JSON goes on stdin: the keys never appear in
 * the arguments, the process list or a log line.
 */

/*
 * cat, not `install /dev/stdin`: CT 104 is unprivileged, and the pipe pct hands
 * in belongs to the host's root, so reopening /dev/stdin by path is refused.
 * cat reads the fd it already has. umask 077 keeps the temp file 600 from the
 * first byte; mv swaps it in whole, so the server never reads half a file.
 */
const KEYS_FILE = "/etc/teez-phone/keys.json";
export const PHONE_KEYS_COMMAND = `pct exec 104 -- sh -c 'umask 077 && cat > ${KEYS_FILE}.tmp && chown teezphone:teezphone ${KEYS_FILE}.tmp && mv ${KEYS_FILE}.tmp ${KEYS_FILE}'`;
const DEFAULT_ALIAS = "pve";
const TIMEOUT_MS = 30_000;
const MAX_ERROR = 300;

export type SshWithInput = (args: readonly string[], stdin: string) => Promise<{ ok: boolean; output: string }>;
export type PhoneKeys = { gemini?: string | null | undefined; groq?: string | null | undefined };

/** Runs the real ssh binary with `stdin` piped in. Output is returned, never logged. */
export const sshWithInput: SshWithInput = (args, stdin) =>
	new Promise((resolve) => {
		const child = spawn(process.platform === "win32" ? "ssh.exe" : "ssh", [...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		let output = "";
		const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ ok: false, output: error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ ok: code === 0, output });
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(stdin);
	});

export async function pushPhoneKeys(keys: PhoneKeys, ssh: SshWithInput = sshWithInput, alias: string = DEFAULT_ALIAS): Promise<{ ok: boolean; message: string }> {
	const body: { gemini?: string; groq?: string } = {};
	if (keys.gemini) body.gemini = keys.gemini;
	if (keys.groq) body.groq = keys.groq;
	if (!body.gemini && !body.groq) return { ok: false, message: "No Feed keys are saved on this PC." };

	const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "--", alias, PHONE_KEYS_COMMAND];
	const result = await ssh(args, JSON.stringify(body));
	if (result.ok) return { ok: true, message: "Sent the Feed keys to the phone server." };
	const detail = result.output.trim().slice(0, MAX_ERROR);
	return { ok: false, message: `Could not send the keys: ${detail || "ssh failed"}` };
}
