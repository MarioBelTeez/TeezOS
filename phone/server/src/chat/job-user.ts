import { spawn as nodeSpawn } from "node:child_process";
import { WRITE_RULES_SCRIPT, type AgyRules } from "../../../../runner/src/agy.ts";
import { asJobUser } from "../../../../runner/src/executor.ts";
import type { ChildLike } from "../../../../src/main/agy/session.ts";

/**
 * Everything the chat runs, it runs as the job user (`agent`) the way the
 * runner does: `sudo -n -H -u agent -- env -C <dir> <file> …` (asJobUser).
 * The service account keeps the secrets; `agent` only has a read-only clone.
 */

export type { ChildLike };
export type SpawnOptions = { readonly cwd: string; readonly env?: NodeJS.ProcessEnv };
export type Spawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildLike;
export type CommandResult = { ok: boolean; output: string };

const RULES_TIMEOUT_MS = 30_000;
/** How long a stopped turn gets to end before it is killed outright. */
export const KILL_GRACE_MS = 10_000;
const MAX_OUTPUT_CHARS = 4000;

export const defaultSpawn: Spawn = (file, args, options) =>
	nodeSpawn(file, [...args], { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

/** Runs a command to its end (or its timeout): `ok` and what it printed. */
export function runToEnd(spawn: Spawn, command: { file: string; args: readonly string[]; cwd: string }, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
	return new Promise((resolve) => {
		let output = "";
		let done = false;
		const finish = (ok: boolean, extra = ""): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ ok, output: `${output}${extra}`.trim().slice(-MAX_OUTPUT_CHARS) });
		};
		let child: ChildLike;
		try {
			child = spawn(command.file, command.args, env ? { cwd: command.cwd, env } : { cwd: command.cwd });
		} catch (error) {
			resolve({ ok: false, output: String(error) });
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			finish(false, `\ntimed out after ${timeoutMs / 1000}s`);
		}, timeoutMs);
		const collect = (chunk: Buffer | string): void => {
			output = (output + String(chunk)).slice(-MAX_OUTPUT_CHARS);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("close", (code) => finish(code === 0));
		child.on("error", (error) => finish(false, `\n${error.message}`));
		child.stdin.on("error", () => undefined);
		child.stdin.end();
	});
}

/**
 * Stops a child: SIGTERM now (sudo passes it on). If it has not closed
 * `graceMs` later, SIGKILL it and kill whatever the job user still runs, so a
 * survivor can never overlap the next turn. SIGKILL cannot be relayed by sudo,
 * hence `killSurvivors` (pkill as the job user, JobUser.killSurvivors).
 */
export function stopChild(child: ChildLike, closed: Promise<void>, killSurvivors: () => void, graceMs = KILL_GRACE_MS): void {
	let ended = false;
	void closed.then(() => (ended = true));
	child.kill();
	const timer = setTimeout(() => {
		if (ended) return;
		console.error("phone: a stopped turn is still running; killing it");
		(child as { kill(signal?: NodeJS.Signals): unknown }).kill("SIGKILL");
		killSurvivors();
	}, graceMs);
	timer.unref?.();
}

export class JobUser {
	readonly #spawn: Spawn;
	readonly #user: string | undefined;

	constructor(spawn: Spawn, user: string | undefined) {
		this.#spawn = spawn;
		this.#user = user || undefined;
	}

	/** Starts `file` as the job user in `cwd`; `keepEnv` names the variables sudo may pass on. */
	spawn(cwd: string, file: string, args: readonly string[], keepEnv: readonly string[] = [], env?: NodeJS.ProcessEnv): ChildLike {
		const command = asJobUser(this.#user, cwd, file, args, keepEnv);
		return this.#spawn(command.file, command.args, env ? { cwd: command.cwd, env } : { cwd: command.cwd });
	}

	/**
	 * Kills every process of the job user. Safe because phone turns run one
	 * at a time across all chats: when one is stuck, nothing else of the job
	 * user's is running (an interactive `su - phoneagent` would be killed too).
	 */
	async killSurvivors(): Promise<void> {
		if (!this.#user) return;
		const command = asJobUser(this.#user, "/", "pkill", ["-KILL", "-u", this.#user]);
		await runToEnd(this.#spawn, command, RULES_TIMEOUT_MS);
	}

	/** agy's allow/deny rules, written by the job user (it owns the settings file), as the runner does. */
	writeAgyRules(rules: AgyRules): Promise<CommandResult> {
		const command = asJobUser(this.#user, "/", process.execPath, ["-e", WRITE_RULES_SCRIPT, JSON.stringify(rules)]);
		return runToEnd(this.#spawn, command, RULES_TIMEOUT_MS);
	}
}
