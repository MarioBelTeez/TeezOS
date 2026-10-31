import { request as httpsRequest, Agent } from "node:https";
import type { PeerCertificate } from "node:tls";

/**
 * The Proxmox VE API, spoken with an API token.
 *
 * Proxmox signs its web certificate with its own root CA, so "ignore
 * certificate errors" is the usual shortcut. Not here: the connection trusts
 * exactly that CA (fetched over SSH at setup) and additionally checks the
 * server certificate's fingerprint during the handshake, before the token is
 * sent. A different certificate fails the request instead of leaking the token.
 */

export type ProxmoxConfig = {
	readonly baseUrl: string;
	readonly node: string;
	readonly tokenId: string;
	readonly fingerprint: string;
	readonly ca: string;
};

export class ProxmoxError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export const normalizeFingerprint = (value: string): string => value.replace(/[^0-9a-f]/gi, "").toLowerCase();

export function makeAgent(ca: string, fingerprint: string): Agent {
	const pinned = normalizeFingerprint(fingerprint);
	return new Agent({
		ca,
		keepAlive: true,
		maxSockets: 4,
		// Connected by IP, so the hostname check is replaced by the pin.
		checkServerIdentity: (_host: string, cert: PeerCertificate): Error | undefined =>
			normalizeFingerprint(cert.fingerprint256) === pinned
				? undefined
				: new Error("The server's certificate changed since setup. Run the Proxmox setup again if you renewed it."),
	});
}

export class ProxmoxClient {
	readonly #config: ProxmoxConfig;
	readonly #secret: string;
	readonly #agent: Agent;

	constructor(config: ProxmoxConfig, secret: string) {
		this.#config = config;
		this.#secret = secret;
		this.#agent = makeAgent(config.ca, config.fingerprint);
	}

	get node(): string {
		return this.#config.node;
	}

	/** The host the API is reached at (the UPS answers there too). */
	get host(): string {
		return new URL(this.#config.baseUrl).hostname;
	}

	request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params?: Record<string, string | number>): Promise<T> {
		const url = new URL(`/api2/json${path}`, this.#config.baseUrl);
		let body: string | null = null;
		if (params && method === "GET") {
			for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
		} else if (params) {
			body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
		}
		return new Promise<T>((resolve, reject) => {
			const req = httpsRequest(
				url,
				{
					method,
					agent: this.#agent,
					timeout: 15_000,
					headers: {
						Authorization: `PVEAPIToken=${this.#config.tokenId}=${this.#secret}`,
						...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}),
					},
				},
				(res) => {
					let raw = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						raw += chunk;
					});
					res.on("end", () => {
						const status = res.statusCode ?? 0;
						if (status < 200 || status >= 300) {
							reject(new ProxmoxError(`${status} ${res.statusMessage ?? ""} ${raw.slice(0, 300)}`.trim(), status));
							return;
						}
						try {
							resolve((JSON.parse(raw) as { data: T }).data);
						} catch {
							reject(new ProxmoxError("The server answered with something that is not JSON.", status));
						}
					});
				},
			);
			req.on("timeout", () => req.destroy(new Error("Proxmox did not answer in 15 seconds.")));
			req.on("error", reject);
			if (body) req.write(body);
			req.end();
		});
	}

	dispose(): void {
		this.#agent.destroy();
	}
}

/** The shapes of the endpoints the Server view reads, trimmed to what it uses. */
export type NodeStatus = {
	readonly cpu: number;
	readonly memory: { readonly used: number; readonly total: number };
	readonly rootfs: { readonly used: number; readonly total: number };
	readonly swap: { readonly used: number; readonly total: number };
	readonly uptime: number;
	readonly loadavg: readonly string[];
	readonly pveversion: string;
	readonly kversion: string;
	readonly cpuinfo: { readonly model: string; readonly cpus: number };
};

export type Guest = {
	readonly vmid: number;
	readonly name: string;
	readonly status: string;
	readonly type: "lxc" | "qemu";
	readonly cpu: number;
	readonly cpus: number;
	readonly mem: number;
	readonly maxmem: number;
	readonly disk: number;
	readonly maxdisk: number;
	readonly uptime: number;
	readonly netin: number;
	readonly netout: number;
	/** IPv4 addresses reported by a running container, e.g. "192.168.1.20". */
	readonly ips?: readonly string[];
};

export type Storage = {
	readonly storage: string;
	readonly type: string;
	readonly used: number;
	readonly total: number;
	readonly active: number;
	readonly content: string;
};

export type ZfsPool = { readonly name: string; readonly health: string; readonly size: number; readonly alloc: number; readonly free: number; readonly frag: number };
export type Task = { readonly upid: string; readonly type: string; readonly id?: string; readonly status?: string; readonly starttime: number; readonly endtime?: number; readonly user: string };
export type RrdPoint = { readonly time: number; readonly cpu?: number; readonly memused?: number; readonly memtotal?: number; readonly netin?: number; readonly netout?: number };
export type Backup = { readonly volid: string; readonly vmid?: number; readonly size: number; readonly ctime: number; readonly notes?: string };
