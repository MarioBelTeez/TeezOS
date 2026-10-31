import { ipcMain, type BrowserWindow } from "electron";
import type { SettingsStore } from "../settings/store.ts";
import { existsSync } from "node:fs";
import { TerminalService, type TerminalProfile } from "../terminal/service.ts";
import { shellsAvailable } from "../terminal/shell.ts";
import { isSessionId } from "../terminal/remote.ts";
import type { ShellChoice } from "../../shared/modules.ts";

/** Terminals over IPC. The window names a workspace and a profile, never a program. */

const PROFILES: readonly TerminalProfile[] = ["shell", "ssh-pve", "ssh-ct", "claude-login", "claude-setup-token", "agy", "claude-remote", "claude-resume-remote"];
const SHELLS: readonly ShellChoice[] = ["auto", "powershell", "gitbash", "cmd"];
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function registerTerminalIpc(store: SettingsStore, getWindow: () => BrowserWindow | null): TerminalService {
	const send = (channel: string, payload: unknown): void => {
		const window = getWindow();
		if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
	};

	const service = new TerminalService({
		data: (id, data) => send("terminal:data", { id, data }),
		exit: (id, exitCode) => send("terminal:exit", { id, exitCode }),
	});

	ipcMain.handle("terminal:create", (_event, request: unknown) => {
		if (typeof request !== "object" || request === null) return null;
		const r = request as Record<string, unknown>;
		const workspace = store.get().workspaces.find((w) => w.id === r["workspaceId"]);
		if (!workspace) return null;
		const profile = PROFILES.includes(r["profile"] as TerminalProfile) ? (r["profile"] as TerminalProfile) : "shell";
		if (profile === "ssh-ct" && !(isNumber(r["vmid"]) && Number.isInteger(r["vmid"]) && r["vmid"] > 0)) return null;
		if (profile === "claude-resume-remote" && !isSessionId(r["sessionId"])) return null;
		// A choice from a fixed list, never a path: anything else is the automatic shell.
		const shell = SHELLS.includes(r["shell"] as ShellChoice) ? (r["shell"] as ShellChoice) : "auto";
		try {
			return service.create({
				workspaceId: workspace.id,
				cwd: workspace.path,
				cols: isNumber(r["cols"]) ? r["cols"] : 100,
				rows: isNumber(r["rows"]) ? r["rows"] : 24,
				profile,
				shell,
				...(profile === "ssh-ct" && isNumber(r["vmid"]) && Number.isInteger(r["vmid"]) && r["vmid"] > 0 ? { vmid: r["vmid"] } : {}),
				...(profile === "claude-resume-remote" && isSessionId(r["sessionId"]) ? { sessionId: r["sessionId"] } : {}),
			});
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("terminal:shells", () => shellsAvailable(process.env, process.platform, existsSync));

	ipcMain.on("terminal:write", (_event, id: unknown, data: unknown) => {
		if (isText(id) && isText(data)) service.write(id, data);
	});

	ipcMain.on("terminal:resize", (_event, id: unknown, cols: unknown, rows: unknown) => {
		if (isText(id) && isNumber(cols) && isNumber(rows)) service.resize(id, cols, rows);
	});

	ipcMain.on("terminal:kill", (_event, id: unknown) => {
		if (isText(id)) service.kill(id);
	});

	return service;
}
