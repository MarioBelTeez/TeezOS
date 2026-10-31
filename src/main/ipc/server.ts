import { Notification, dialog, ipcMain, type BrowserWindow } from "electron";
import type { SettingsStore } from "../settings/store.ts";
import type { SecretStore } from "../settings/secrets.ts";
import { ProxmoxClient } from "../proxmox/client.ts";
import { look } from "../proxmox/look.ts";
import { buildOverview, type ServerOverview } from "../proxmox/overview.ts";
import { setupViaSsh } from "../proxmox/setup.ts";
import { diffAlerts, type Snapshot } from "../proxmox/watch.ts";

/** How often the server is checked in the background, and how soon after start. */
const WATCH_MS = 5 * 60_000;
const FIRST_WATCH_MS = 30_000;

/**
 * The Server view's access to Proxmox. The token never leaves this process;
 * power actions and backups are confirmed in a native dialog here, so the
 * window cannot skip the question.
 */

export type { ServerOverview };

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const GUEST_ACTIONS = ["start", "stop", "shutdown", "reboot"] as const;
type GuestAction = (typeof GUEST_ACTIONS)[number];

export function registerServerIpc(store: SettingsStore, secrets: SecretStore, getWindow: () => BrowserWindow | null): () => void {
	let client: ProxmoxClient | null = null;

	const getClient = (): ProxmoxClient | null => {
		if (client) return client;
		const config = store.get().proxmox;
		const secret = secrets.get("proxmox");
		if (!config || !secret) return null;
		client = new ProxmoxClient(config, secret);
		return client;
	};

	const resetClient = (): void => {
		client?.dispose();
		client = null;
	};

	const confirm = async (message: string, detail: string, action: string): Promise<boolean> => {
		const window = getWindow();
		const options = { type: "warning" as const, buttons: [action, "Cancel"], defaultId: 1, cancelId: 1, title: "Proxmox", message, detail };
		const answer = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
		return answer.response === 0;
	};

	const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

	ipcMain.handle("server:status", () => {
		const config = store.get().proxmox;
		return { configured: !!config && secrets.has("proxmox"), baseUrl: config?.baseUrl ?? null, node: config?.node ?? null, tokenId: config?.tokenId ?? null };
	});

	ipcMain.handle("server:setup", async (_event, alias: unknown): Promise<Result<string>> => {
		const host = typeof alias === "string" && alias.trim() ? alias.trim() : "pve";
		try {
			const { config, secret } = await setupViaSsh(host);
			secrets.set("proxmox", secret);
			store.update((s) => ({ ...s, proxmox: config }));
			resetClient();
			return { ok: true, value: `${config.tokenId} on ${config.baseUrl}` };
		} catch (error) {
			return { ok: false, reason: message(error) };
		}
	});

	ipcMain.handle("server:disconnect", () => {
		secrets.delete("proxmox");
		store.update((s) => ({ ...s, proxmox: null }));
		resetClient();
	});

	ipcMain.handle("server:overview", async (): Promise<Result<ServerOverview>> => {
		const api = getClient();
		if (!api) return { ok: false, reason: "not-configured" };
		try {
			return { ok: true, value: await buildOverview(api) };
		} catch (error) {
			return { ok: false, reason: message(error) };
		}
	});

	ipcMain.handle("server:guest-action", async (_event, type: unknown, vmid: unknown, action: unknown): Promise<Result<string>> => {
		const api = getClient();
		if (!api) return { ok: false, reason: "not-configured" };
		if ((type !== "lxc" && type !== "qemu") || typeof vmid !== "number" || !Number.isInteger(vmid) || !GUEST_ACTIONS.includes(action as GuestAction)) {
			return { ok: false, reason: "Bad request." };
		}
		if (action !== "start") {
			const sure = await confirm(`${String(action)} ${type === "lxc" ? "container" : "VM"} ${vmid}?`, "Anything running inside it stops.", String(action).replace(/^./, (c) => c.toUpperCase()));
			if (!sure) return { ok: false, reason: "cancelled" };
		}
		try {
			const upid = await api.request<string>("POST", `/nodes/${api.node}/${type}/${vmid}/status/${String(action)}`);
			return { ok: true, value: upid };
		} catch (error) {
			return { ok: false, reason: message(error) };
		}
	});

	ipcMain.handle("server:backup-now", async (_event, vmid: unknown, storage: unknown): Promise<Result<string>> => {
		const api = getClient();
		if (!api) return { ok: false, reason: "not-configured" };
		if (typeof vmid !== "number" || !Number.isInteger(vmid) || typeof storage !== "string" || !/^[\w.-]+$/.test(storage)) {
			return { ok: false, reason: "Bad request." };
		}
		const sure = await confirm(`Back up guest ${vmid} now?`, `Snapshot mode to ${storage}; the guest keeps running.`, "Back up");
		if (!sure) return { ok: false, reason: "cancelled" };
		try {
			const upid = await api.request<string>("POST", `/nodes/${api.node}/vzdump`, { vmid, storage, mode: "snapshot", compress: "zstd" });
			return { ok: true, value: upid };
		} catch (error) {
			return { ok: false, reason: message(error) };
		}
	});

	ipcMain.handle("server:host-action", async (_event, action: unknown): Promise<Result<string>> => {
		const api = getClient();
		if (!api) return { ok: false, reason: "not-configured" };
		if (action !== "reboot" && action !== "shutdown") return { ok: false, reason: "Bad request." };
		const sure = await confirm(
			action === "reboot" ? "Reboot the Proxmox host?" : "Shut down the Proxmox host?",
			action === "reboot"
				? "Every container stops and starts again; Tailscale and AdGuard (DNS for the house) are down for a minute or two."
				: "Every container stops and the server stays off until someone presses its power button. Do not switch off the PSU — the BIOS forgets its settings.",
			action === "reboot" ? "Reboot" : "Shut down",
		);
		if (!sure) return { ok: false, reason: "cancelled" };
		try {
			await api.request<null>("POST", `/nodes/${api.node}/status`, { command: action });
			return { ok: true, value: action };
		} catch (error) {
			return { ok: false, reason: message(error) };
		}
	});

	const stopWatch = watchServer(store, getClient, getWindow);
	return () => {
		stopWatch();
		resetClient();
	};
}

/**
 * A look at the server every five minutes, whatever view is open: a power
 * cut, a guest that stopped, a failed backup, a sick pool or a full disk
 * becomes a notification once. "Not answering" needs two misses in a row, so
 * a blip on the network stays quiet.
 */
function watchServer(store: SettingsStore, getClient: () => ProxmoxClient | null, getWindow: () => BrowserWindow | null): () => void {
	let last: Snapshot | null = null;
	let misses = 0;
	const shown = new Set<Notification>();
	let running = false;

	const tell = (title: string, body: string): void => {
		if (!store.get().agent.notify || !Notification.isSupported()) return;
		const note = new Notification({ title, body });
		note.on("click", () => {
			const window = getWindow();
			if (!window || window.isDestroyed()) return;
			if (window.isMinimized()) window.restore();
			window.show();
			window.focus();
			window.webContents.send("server:open");
		});
		// Held until closed: a notification nobody references can be collected, and its click lost.
		shown.add(note);
		note.on("close", () => shown.delete(note));
		note.show();
	};

	const check = async (): Promise<void> => {
		const api = getClient();
		if (!api || running) return;
		running = true;
		try {
			let snapshot: Snapshot;
			try {
				snapshot = await look(api, Date.now, last?.at);
				misses = 0;
			} catch {
				misses += 1;
				if (misses < 2) return;
				snapshot = { at: Math.floor(Date.now() / 1000), reachable: false, ups: null, guests: [], zfs: [], disks: [], tasks: [] };
			}
			for (const alert of diffAlerts(last, snapshot)) tell(alert.title, alert.body);
			last = snapshot;
		} finally {
			running = false;
		}
	};

	const first = setTimeout(() => void check(), FIRST_WATCH_MS);
	const timer = setInterval(() => void check(), WATCH_MS);
	return () => {
		clearTimeout(first);
		clearInterval(timer);
	};
}
