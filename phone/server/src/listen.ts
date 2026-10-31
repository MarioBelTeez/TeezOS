import { chmod, lstat, unlink } from "node:fs/promises";
import type { Server } from "node:http";
import type { PhoneConfig } from "./config.ts";

/** Owner only: tailscaled runs as root and reaches it anyway; no other account may. */
const SOCKET_MODE = 0o600;

/** Removes a socket left by a run that did not shut down; anything else at the path is an error, never deleted. */
async function removeStaleSocket(socket: string): Promise<void> {
	let found;
	try {
		found = await lstat(socket);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!found.isSocket()) throw new Error(`${socket} exists and is not a socket; refusing to replace it`);
	await unlink(socket);
}

function listening(server: Server, start: () => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const fail = (error: Error): void => reject(error);
		server.once("error", fail);
		server.once("listening", () => {
			server.off("error", fail);
			resolve();
		});
		start();
	});
}

/**
 * Starts the server: on the unix socket `tailscale serve` forwards to, or
 * (with no socket configured: tests and dev) on loopback TCP. Resolves with
 * where it listens.
 */
export async function listenPhone(server: Server, config: Pick<PhoneConfig, "socket" | "host" | "port">): Promise<string> {
	if (config.socket === "") {
		await listening(server, () => server.listen(config.port, config.host));
		const address = server.address();
		return typeof address === "object" && address ? `${address.address}:${address.port}` : `${config.host}:${config.port}`;
	}
	await removeStaleSocket(config.socket);
	await listening(server, () => server.listen(config.socket));
	await chmod(config.socket, SOCKET_MODE);
	return config.socket;
}

/** How long a shutdown may take before the process exits anyway. */
export const SHUTDOWN_FORCE_MS = 5000;

export type ShutdownDeps = {
	/** Stops the watchers and intervals. */
	readonly stop: () => void;
	/** Settles once local git work in progress is done (a killed commit would leave index.lock behind). */
	readonly idle: () => Promise<void>;
	readonly exit: (code: number) => void;
	readonly forceMs?: number;
};

/**
 * Stops the timers, closes the server and every open connection (event
 * streams never end by themselves, so `close` alone would wait forever),
 * waits for local git work, then exits; after `forceMs` it exits 1 anyway.
 */
export function shutdownPhone(server: Server, deps: ShutdownDeps): void {
	deps.stop();
	const force = setTimeout(() => {
		console.error("phone: shutdown took too long; exiting anyway");
		deps.exit(1);
	}, deps.forceMs ?? SHUTDOWN_FORCE_MS);
	force.unref();
	const closed = new Promise<void>((resolve) => server.close(() => resolve()));
	server.closeAllConnections();
	Promise.all([closed, deps.idle()])
		.then(() => {
			clearTimeout(force);
			deps.exit(0);
		})
		.catch((error: unknown) => console.error("phone: shutdown failed", error));
}
