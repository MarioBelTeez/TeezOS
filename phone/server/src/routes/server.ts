import { readFileSync } from "node:fs";
import path from "node:path";
import { ProxmoxClient, type ProxmoxConfig } from "../../../../src/main/proxmox/client.ts";
import type { LookApi } from "../../../../src/main/proxmox/look.ts";
import type { ServerOverview } from "../../../../src/main/proxmox/overview.ts";
import type { Snapshot } from "../../../../src/main/proxmox/watch.ts";
import type { Route } from "../http.ts";

/**
 * Server monitoring, read-only: one GET that answers with the alert snapshot
 * and the overview the desktop Server view shows. There is deliberately no
 * route that changes anything on the server.
 */

const PATH = "/api/server";
const NOT_SET_UP = "Server monitoring is not set up yet.";
const PROXMOX_FIELDS = ["baseUrl", "node", "tokenId", "fingerprint", "ca", "secret"] as const;

export type ServerRouteDeps = {
	/** The Proxmox client, or null when `proxmox.json` is missing. */
	readonly api: () => LookApi | null;
	readonly look: (api: LookApi) => Promise<Snapshot>;
	readonly overview: (api: LookApi) => Promise<ServerOverview>;
};

export function createServerRoute(deps: ServerRouteDeps): Route {
	return async (req, url) => {
		if (url.pathname !== PATH) return null;
		if (req.method !== "GET") return { status: 405, body: { error: "method not allowed" } };
		const api = deps.api();
		if (!api) return { status: 503, body: { error: NOT_SET_UP } };
		try {
			const [snapshot, overview] = await Promise.all([deps.look(api), deps.overview(api)]);
			return { status: 200, body: { snapshot, overview } };
		} catch (error) {
			console.error("phone: server read failed", error);
			return { status: 502, body: { error: "The server did not answer." } };
		}
	};
}

/** The read-only Proxmox client from `<secretsDir>/proxmox.json` (ProxmoxConfig fields plus `secret`); null if absent or incomplete. */
export function loadProxmoxClient(secretsDir: string): ProxmoxClient | null {
	try {
		const raw = JSON.parse(readFileSync(path.join(secretsDir, "proxmox.json"), "utf8")) as Record<string, unknown>;
		if (!PROXMOX_FIELDS.every((field) => typeof raw[field] === "string" && raw[field] !== "")) return null;
		const config: ProxmoxConfig = {
			baseUrl: String(raw["baseUrl"]),
			node: String(raw["node"]),
			tokenId: String(raw["tokenId"]),
			fingerprint: String(raw["fingerprint"]),
			ca: String(raw["ca"]),
		};
		return new ProxmoxClient(config, String(raw["secret"]));
	} catch {
		return null;
	}
}
