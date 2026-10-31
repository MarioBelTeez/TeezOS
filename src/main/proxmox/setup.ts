import { execFile } from "node:child_process";
import { connect as tlsConnect } from "node:tls";
import { ProxmoxClient, type ProxmoxConfig } from "./client.ts";

/**
 * One-click access to the Proxmox host, using the SSH key that already works
 * (`ssh pve`). Over that SSH session it creates — or recreates — a dedicated
 * `teezai@pve` user with a custom role and an API token, reads the cluster's
 * root CA, and the app pins the web certificate it sees. Re-running it rotates
 * the token.
 *
 * The role is limited to what the Server view does: read status, power guests
 * on and off, take backups, reboot the host. It cannot create or delete
 * guests, change their configuration, or manage users.
 */

export const ROLE = "TeezAI";
export const USER = "teezai@pve";
export const TOKEN = "app";
export const PRIVILEGES = [
	"Sys.Audit",
	"Sys.PowerMgmt",
	"VM.Audit",
	"VM.PowerMgmt",
	"VM.Backup",
	"Datastore.Audit",
	"Datastore.AllocateSpace",
	"Pool.Audit",
].join(",");

/** Run on the host. Idempotent: the role and user are updated if they exist. */
export const SETUP_SCRIPT = [
	"set -e",
	`pveum role add ${ROLE} -privs "${PRIVILEGES}" 2>/dev/null || pveum role modify ${ROLE} -privs "${PRIVILEGES}"`,
	`pveum user add ${USER} --comment "TeezAI desktop app" 2>/dev/null || true`,
	`pveum acl modify / -user ${USER} -role ${ROLE}`,
	`pveum user token remove ${USER} ${TOKEN} 2>/dev/null || true`,
	`pveum user token add ${USER} ${TOKEN} --privsep 0 --comment "TeezAI" --output-format json`,
].join(" && ");

/** An alias may not start with "-", or ssh would read it as an option. */
export const ALIAS = /^[A-Za-z0-9][\w.@-]*$/;

function ssh(alias: string, command: string, timeout = 30_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			process.platform === "win32" ? "ssh.exe" : "ssh",
			["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "--", alias, command],
			{ timeout, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => (error ? reject(new Error(`ssh ${alias}: ${(stderr || error.message).trim()}`)) : resolve(stdout)),
		);
	});
}

/** `ssh -G` resolves an alias from ~/.ssh/config without connecting. */
function resolveHost(alias: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(process.platform === "win32" ? "ssh.exe" : "ssh", ["-G", "--", alias], { windowsHide: true, encoding: "utf8" }, (error, stdout) => {
			if (error) return reject(new Error(`Could not read the SSH config for ${alias}.`));
			const line = stdout.split(/\r?\n/).find((l) => l.startsWith("hostname "));
			resolve(line ? line.slice("hostname ".length).trim() : alias);
		});
	});
}

/** The certificate the web interface presents, verified against the CA. */
function readFingerprint(host: string, port: number, ca: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = tlsConnect({ host, port, ca, checkServerIdentity: () => undefined, timeout: 10_000 }, () => {
			const cert = socket.getPeerCertificate();
			socket.end();
			if (!cert?.fingerprint256) return reject(new Error("The server sent no certificate."));
			resolve(cert.fingerprint256);
		});
		socket.on("error", (error) => reject(new Error(`TLS to ${host}:${port}: ${error.message}`)));
		socket.on("timeout", () => {
			socket.destroy();
			reject(new Error(`No answer from ${host}:${port}.`));
		});
	});
}

export function parseTokenOutput(output: string): { tokenId: string; secret: string } {
	const json = output.slice(output.indexOf("{"));
	const parsed = JSON.parse(json) as { "full-tokenid"?: string; value?: string };
	if (!parsed.value || !parsed["full-tokenid"]) throw new Error("pveum did not return a token.");
	return { tokenId: parsed["full-tokenid"], secret: parsed.value };
}

export async function setupViaSsh(alias: string): Promise<{ readonly config: ProxmoxConfig; readonly secret: string }> {
	if (!ALIAS.test(alias)) throw new Error("That does not look like an SSH host alias.");
	const host = await resolveHost(alias);
	const node = (await ssh(alias, "hostname")).trim();
	const ca = await ssh(alias, "cat /etc/pve/pve-root-ca.pem");
	if (!ca.includes("BEGIN CERTIFICATE")) throw new Error("Could not read /etc/pve/pve-root-ca.pem — is this a Proxmox host?");
	const { tokenId, secret } = parseTokenOutput(await ssh(alias, SETUP_SCRIPT, 60_000));
	const fingerprint = await readFingerprint(host, 8006, ca);
	const config: ProxmoxConfig = { baseUrl: `https://${host}:8006`, node, tokenId, fingerprint, ca };

	// Prove the token works before saving anything.
	const client = new ProxmoxClient(config, secret);
	try {
		await client.request("GET", "/version");
	} finally {
		client.dispose();
	}
	return { config, secret };
}
