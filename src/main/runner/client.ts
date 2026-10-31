import { execFile } from "node:child_process";
import { request as httpsRequest, Agent } from "node:https";
import { connect as tlsConnect, type PeerCertificate } from "node:tls";
import { normalizeFingerprint } from "../proxmox/client.ts";

/**
 * The app's side of teez-runner. The runner presents a self-signed
 * certificate; the app trusts exactly that certificate (as its own CA) and
 * checks its fingerprint during the handshake, so the bearer token only ever
 * goes to the runner it was set up with.
 */

export type RunnerConfig = {
	readonly baseUrl: string;
	readonly fingerprint: string;
	readonly ca: string;
	readonly vmid: number;
};

export class RunnerError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export class RunnerClient {
	readonly #config: RunnerConfig;
	readonly #token: string;
	readonly #agent: Agent;

	constructor(config: RunnerConfig, token: string) {
		this.#config = config;
		this.#token = token;
		const pinned = normalizeFingerprint(config.fingerprint);
		this.#agent = new Agent({
			ca: config.ca,
			keepAlive: true,
			checkServerIdentity: (_host: string, cert: PeerCertificate) =>
				normalizeFingerprint(cert.fingerprint256) === pinned ? undefined : new Error("The runner's certificate changed. Connect it again."),
		});
	}

	request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
		const url = new URL(path, this.#config.baseUrl);
		const payload = body === undefined ? null : JSON.stringify(body);
		return new Promise<T>((resolve, reject) => {
			const req = httpsRequest(
				url,
				{
					method,
					agent: this.#agent,
					timeout: 20_000,
					headers: {
						Authorization: `Bearer ${this.#token}`,
						...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
					},
				},
				(res) => {
					let raw = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						raw += chunk;
					});
					res.on("end", () => {
						let parsed: unknown = null;
						try {
							parsed = raw ? JSON.parse(raw) : null;
						} catch {
							// fall through with null
						}
						const status = res.statusCode ?? 0;
						if (status >= 200 && status < 300) return resolve(parsed as T);
						const error = parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : `HTTP ${status}`;
						reject(new RunnerError(error, status));
					});
				},
			);
			req.on("timeout", () => req.destroy(new Error("The runner did not answer.")));
			req.on("error", reject);
			if (payload) req.write(payload);
			req.end();
		});
	}

	dispose(): void {
		this.#agent.destroy();
	}
}

function ssh(alias: string, command: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			process.platform === "win32" ? "ssh.exe" : "ssh",
			["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "--", alias, command],
			{ timeout: 30_000, windowsHide: true, encoding: "utf8" },
			(error, stdout, stderr) => (error ? reject(new Error(`ssh ${alias}: ${(stderr || error.message).trim()}`)) : resolve(stdout)),
		);
	});
}

function fingerprintOf(host: string, port: number, ca: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = tlsConnect({ host, port, ca, checkServerIdentity: () => undefined, timeout: 10_000 }, () => {
			const cert = socket.getPeerCertificate();
			socket.end();
			if (cert?.fingerprint256) resolve(cert.fingerprint256);
			else reject(new Error("The runner sent no certificate."));
		});
		socket.on("error", (error) => reject(new Error(`TLS to ${host}:${port}: ${error.message}`)));
		socket.on("timeout", () => {
			socket.destroy();
			reject(new Error(`No answer from ${host}:${port}.`));
		});
	});
}

/**
 * Read the runner's address, token and certificate off its container through
 * the Proxmox host (`ssh pve pct exec <vmid> -- cat …`), then pin what the
 * runner presents. Nothing is typed or copied by hand.
 */
export async function connectViaSsh(alias: string, vmid: number): Promise<{ readonly config: RunnerConfig; readonly token: string }> {
	if (!/^[A-Za-z0-9][\w.@-]*$/.test(alias) || !Number.isInteger(vmid) || vmid < 100 || vmid > 999_999_999) throw new Error("Bad host or container id.");
	const net = await ssh(alias, `pct config ${vmid}`);
	const ip = /ip=(\d+\.\d+\.\d+\.\d+)/.exec(net)?.[1];
	if (!ip) throw new Error(`CT ${vmid} has no static IP (provision it with runner/deploy/provision.sh).`);
	const token = (await ssh(alias, `pct exec ${vmid} -- cat /etc/teez-runner/token`)).trim();
	const ca = await ssh(alias, `pct exec ${vmid} -- cat /etc/teez-runner/tls.crt`);
	if (token.length < 32 || !ca.includes("BEGIN CERTIFICATE")) throw new Error(`CT ${vmid} does not look like a teez-runner.`);
	const port = 7420;
	const fingerprint = await fingerprintOf(ip, port, ca);
	const config: RunnerConfig = { baseUrl: `https://${ip}:${port}`, fingerprint, ca, vmid };
	const client = new RunnerClient(config, token);
	try {
		await client.request("GET", "/health");
	} finally {
		client.dispose();
	}
	return { config, token };
}
