import { existsSync } from "node:fs";
import path from "node:path";

export type PhoneConfig = {
	/** The unix socket `tailscale serve` forwards to (production); "" listens on host:port instead (tests and dev only). */
	socket: string;
	port: number;
	host: "127.0.0.1";
	allowedLogin: string;
	dataDir: string;
	vaultDir: string;
	agentVaultDir: string;
	appDir: string;
	secretsDir: string;
	jobUser: string;
	runnerUrl: string;
	/** The runner's self-signed certificate, trusted and pinned for runner calls. */
	runnerCert: string;
	/** agy for the job user; "" finds it through the job user's login shell. */
	agyPath: string;
	/** claude for the job user; "" finds it the same way. */
	claudePath: string;
	/** The /watch plugin's watch.py for video sources; "" finds the newest copy in the plugin cache. */
	watchScript: string;
};

const DEFAULT_PORT = 7430;
/** Reachable only by teezphone and root (tailscaled): RuntimeDirectory 0750, the socket 0600. */
export const DEFAULT_SOCKET = "/run/teez-phone/phone.sock";

function parsePort(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`TEEZ_PHONE_PORT is not a valid port: ${raw}`);
	return port;
}

/** The service settings from the environment; every value has the production default. */
export function loadConfig(env: NodeJS.ProcessEnv): PhoneConfig {
	const text = (name: string, fallback: string): string => {
		const value = env[name];
		return value === undefined || value === "" ? fallback : value;
	};
	return {
		// The socket unless TEEZ_PHONE_SOCKET is set to "" on purpose: a TCP port, even on loopback,
		// is reachable by every local account (and possibly by tailnet peers through tailscaled's netstack).
		socket: env["TEEZ_PHONE_SOCKET"] ?? DEFAULT_SOCKET,
		port: parsePort(env["TEEZ_PHONE_PORT"]),
		// Loopback only, and only without a socket (tests and dev).
		host: "127.0.0.1",
		// No default: the service refuses to start until the owner names their own Tailscale login.
		allowedLogin: text("TEEZ_PHONE_LOGIN", ""),
		dataDir: text("TEEZ_PHONE_DATA", "/var/lib/teez-phone/data"),
		vaultDir: text("TEEZ_PHONE_VAULT", "/var/lib/teez-phone/vault"),
		// Chats read the service's own clone (group read); they never pull or write there.
		agentVaultDir: text("TEEZ_PHONE_AGENT_VAULT", "/var/lib/teez-phone/vault"),
		appDir: text("TEEZ_PHONE_APP", "/opt/teez-phone/app"),
		secretsDir: text("TEEZ_PHONE_SECRETS", "/etc/teez-phone"),
		// Its own account (own HOME and agy login), so its agy rules never meet the runner's `agent`.
		jobUser: text("TEEZ_PHONE_JOB_USER", "phoneagent"),
		runnerUrl: text("TEEZ_PHONE_RUNNER", "https://127.0.0.1:7420"),
		runnerCert: text("TEEZ_PHONE_RUNNER_CERT", "/etc/teez-phone/runner.crt"),
		agyPath: text("TEEZ_PHONE_AGY", ""),
		claudePath: text("TEEZ_PHONE_CLAUDE", ""),
		watchScript: text("TEEZ_PHONE_WATCH", ""),
	};
}

/** The variable each path setting comes from; "" means optional (looked up when empty). */
const PATHS: readonly { key: keyof PhoneConfig; env: string; optional: boolean }[] = [
	{ key: "dataDir", env: "TEEZ_PHONE_DATA", optional: false },
	{ key: "vaultDir", env: "TEEZ_PHONE_VAULT", optional: false },
	{ key: "agentVaultDir", env: "TEEZ_PHONE_AGENT_VAULT", optional: false },
	{ key: "appDir", env: "TEEZ_PHONE_APP", optional: false },
	{ key: "secretsDir", env: "TEEZ_PHONE_SECRETS", optional: false },
	{ key: "runnerCert", env: "TEEZ_PHONE_RUNNER_CERT", optional: false },
	{ key: "agyPath", env: "TEEZ_PHONE_AGY", optional: true },
	{ key: "claudePath", env: "TEEZ_PHONE_CLAUDE", optional: true },
	{ key: "watchScript", env: "TEEZ_PHONE_WATCH", optional: true },
];

/** True when `inner` is `outer` or a folder inside it. */
function within(outer: string, inner: string): boolean {
	const relative = path.relative(path.resolve(outer), path.resolve(inner));
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** What is wrong with the settings, one line each; empty when they can run. */
export function validateConfig(config: PhoneConfig): string[] {
	const problems: string[] = [];
	for (const { key, env, optional } of PATHS) {
		const value = String(config[key]);
		if (optional && value === "") continue;
		if (!path.isAbsolute(value)) problems.push(`${env} must be an absolute path: ${value}`);
	}
	// The data folder is 700 and the vault group-readable: neither may sit inside the other.
	if (within(config.dataDir, config.vaultDir) || within(config.vaultDir, config.dataDir)) problems.push("TEEZ_PHONE_DATA and TEEZ_PHONE_VAULT must be separate folders (neither inside the other)");
	if (config.socket !== "" && !path.isAbsolute(config.socket)) problems.push(`TEEZ_PHONE_SOCKET must be an absolute path (or empty for TCP): ${config.socket}`);
	if (config.allowedLogin.trim() === "") problems.push("TEEZ_PHONE_LOGIN is empty");
	if (!/^https:\/\/[^\s/]+/.test(config.runnerUrl)) problems.push(`TEEZ_PHONE_RUNNER must be an https URL: ${config.runnerUrl}`);
	return problems;
}

/** The secret files the service reads; --check-config says which exist, never what is in them. */
const SECRET_FILES = ["keys.json", "vapid.json", "proxmox.json", "runner-token", "claude-token"] as const;

/** `--check-config`: parses and validates the environment the way a start would, without starting anything. */
export function checkConfig(env: NodeJS.ProcessEnv): { ok: boolean; text: string } {
	let config: PhoneConfig;
	try {
		config = loadConfig(env);
	} catch (error) {
		return { ok: false, text: `config: ${error instanceof Error ? error.message : String(error)}` };
	}
	const problems = validateConfig(config);
	// A deploy check: the service cannot run before its vault clone exists.
	if (!existsSync(path.join(config.vaultDir, ".git"))) problems.push(`TEEZ_PHONE_VAULT is not a git clone: ${config.vaultDir}`);
	if (problems.length > 0) return { ok: false, text: problems.map((line) => `config: ${line}`).join("\n") };
	const lines = [
		`config ok: ${config.socket ? `socket ${config.socket}` : `TCP ${config.host}:${config.port} (no socket: tests and dev only)`}, login ${config.allowedLogin}, job user ${config.jobUser}`,
		`data ${config.dataDir}, vault ${config.vaultDir}, chats read ${config.agentVaultDir}, app ${config.appDir}`,
		`runner ${config.runnerUrl} (cert ${config.runnerCert}), watch.py ${config.watchScript || "(plugin cache)"}`,
		...SECRET_FILES.map((name) => `${name}: ${existsSync(path.join(config.secretsDir, name)) ? "present" : "missing"}`),
	];
	return { ok: true, text: lines.join("\n") };
}
