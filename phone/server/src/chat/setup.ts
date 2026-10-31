import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { asJobUser } from "../../../../runner/src/executor.ts";
import type { PhoneConfig } from "../config.ts";
import type { SaveCapture } from "../routes/captures.ts";
import { ChatService } from "./chat-service.ts";
import { ChatStore } from "./chat-store.ts";
import { defaultSpawn } from "./job-user.ts";

const LOOKUP_TIMEOUT_MS = 60_000;
const REFRESH_MS = 10 * 60_000;

/**
 * Where a program is for the job user. agy and claude install into
 * ~/.local/bin, which only a login shell has on the PATH: the runner's
 * probeAgy lookup (`bash -lc "command -v …"`), as the job user.
 */
function locate(jobUser: string, name: string): Promise<string | null> {
	return new Promise((resolve) => {
		const command = asJobUser(jobUser || undefined, "/", "bash", ["-lc", `command -v ${name}`]);
		execFile(command.file, command.args, { cwd: command.cwd, encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS }, (error, stdout) =>
			resolve(error ? null : stdout.trim().split("\n").pop()?.trim() || null),
		);
	});
}

/** The chat service as the server runs it: the job user, the service's vault clone (read only for it), the optional Claude token. */
export function createChatService(
	config: PhoneConfig,
	saveCapture: SaveCapture,
	/** Pulls the service's own vault clone (GitSync.pull). */
	freshen: () => Promise<boolean>,
) {
	const tokenFile = path.join(config.secretsDir, "claude-token");
	let agyPath: string | null = config.agyPath || null;
	let claudePath = config.claudePath || "claude";

	const refresh = async (): Promise<void> => {
		if (!config.agyPath) {
			const found = await locate(config.jobUser, "agy");
			// One failed lookup (a slow login shell) keeps the last known path.
			if (found || !agyPath) agyPath = found;
			if (!agyPath) console.error("phone: agy not found for the job user; Antigravity chats stay unavailable");
		}
		if (!config.claudePath) claudePath = (await locate(config.jobUser, "claude")) ?? claudePath;
	};
	void refresh();
	const refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
	refreshTimer.unref();

	const service = new ChatService({
		store: new ChatStore(config.dataDir),
		saveCapture,
		spawn: defaultSpawn,
		jobUser: config.jobUser,
		agentVaultDir: config.agentVaultDir,
		agyPath: () => agyPath,
		get claudePath() {
			return claudePath;
		},
		freshen,
		claudeToken: () => (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() || null : null),
	});
	return { service, claudeEnabled: () => existsSync(tokenFile), stop: () => clearInterval(refreshTimer) };
}
