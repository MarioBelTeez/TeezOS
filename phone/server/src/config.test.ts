import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkConfig, loadConfig, validateConfig } from "./config.ts";

describe("loadConfig", () => {
	it("has the production defaults", () => {
		const config = loadConfig({ TEEZ_PHONE_LOGIN: "owner@github" });
		expect(config.socket).toBe("/run/teez-phone/phone.sock");
		expect(config.port).toBe(7430);
		expect(config.dataDir).toBe("/var/lib/teez-phone/data");
		expect(config.runnerCert).toBe("/etc/teez-phone/runner.crt");
		expect(config.watchScript).toBe("");
		expect(validateConfig(config)).toEqual([]);
	});

	it("has no default login: the service must be told whose phone it serves", () => {
		const config = loadConfig({});
		expect(config.allowedLogin).toBe("");
		expect(validateConfig(config)).toContain("TEEZ_PHONE_LOGIN is empty");
	});

	it("listens on TCP only when TEEZ_PHONE_SOCKET is set and empty (tests and dev)", () => {
		expect(loadConfig({ TEEZ_PHONE_SOCKET: "" }).socket).toBe("");
		expect(loadConfig({ TEEZ_PHONE_SOCKET: "/run/x/y.sock" }).socket).toBe("/run/x/y.sock");
	});

	it("reads TEEZ_PHONE_WATCH", () => {
		expect(loadConfig({ TEEZ_PHONE_WATCH: "/opt/teez-phone/watch/watch.py" }).watchScript).toBe("/opt/teez-phone/watch/watch.py");
	});
});

describe("validateConfig", () => {
	it("refuses relative paths, a non-https runner and an empty login", () => {
		const config = { ...loadConfig({ TEEZ_PHONE_DATA: "data", TEEZ_PHONE_RUNNER: "http://127.0.0.1:7420", TEEZ_PHONE_WATCH: "watch.py" }), allowedLogin: " " };
		const problems = validateConfig(config);
		expect(problems).toContain("TEEZ_PHONE_DATA must be an absolute path: data");
		expect(problems).toContain("TEEZ_PHONE_WATCH must be an absolute path: watch.py");
		expect(problems).toContain("TEEZ_PHONE_RUNNER must be an https URL: http://127.0.0.1:7420");
		expect(problems).toContain("TEEZ_PHONE_LOGIN is empty");
	});

	it("refuses a relative socket path", () => {
		expect(validateConfig(loadConfig({ TEEZ_PHONE_SOCKET: "phone.sock" }))).toContain("TEEZ_PHONE_SOCKET must be an absolute path (or empty for TCP): phone.sock");
	});

	it("refuses a data folder that is, holds, or sits in the vault clone", () => {
		const message = "TEEZ_PHONE_DATA and TEEZ_PHONE_VAULT must be separate folders (neither inside the other)";
		expect(validateConfig(loadConfig({ TEEZ_PHONE_LOGIN: "owner@github", TEEZ_PHONE_DATA: "/srv/x", TEEZ_PHONE_VAULT: "/srv/x/" }))).toContain(message);
		expect(validateConfig(loadConfig({ TEEZ_PHONE_LOGIN: "owner@github", TEEZ_PHONE_DATA: "/srv/x", TEEZ_PHONE_VAULT: "/srv/x/vault" }))).toContain(message);
		expect(validateConfig(loadConfig({ TEEZ_PHONE_LOGIN: "owner@github", TEEZ_PHONE_DATA: "/srv/x/vault/data", TEEZ_PHONE_VAULT: "/srv/x/vault" }))).toContain(message);
		expect(validateConfig(loadConfig({ TEEZ_PHONE_LOGIN: "owner@github", TEEZ_PHONE_DATA: "/srv/x/data", TEEZ_PHONE_VAULT: "/srv/x/vault" }))).toEqual([]);
		expect(validateConfig(loadConfig({ TEEZ_PHONE_LOGIN: "owner@github", TEEZ_PHONE_DATA: "/srv/x/..data", TEEZ_PHONE_VAULT: "/srv/x/vault" }))).toEqual([]);
	});
});

describe("checkConfig", () => {
	let root: string;
	let secrets: string;
	let vault: string;
	let env: NodeJS.ProcessEnv;
	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "phone-check-"));
		secrets = path.join(root, "etc");
		vault = path.join(root, "vault");
		await mkdir(secrets);
		await mkdir(path.join(vault, ".git"), { recursive: true });
		env = { TEEZ_PHONE_LOGIN: "owner@github", TEEZ_PHONE_SECRETS: secrets, TEEZ_PHONE_VAULT: vault, TEEZ_PHONE_DATA: path.join(root, "data") };
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("passes a valid environment and lists which secret files are there, never their contents", async () => {
		await writeFile(path.join(secrets, "vapid.json"), '{"publicKey":"PUB","privateKey":"PRIVATE-VALUE"}');
		const result = checkConfig(env);
		expect(result.ok).toBe(true);
		expect(result.text).toContain("vapid.json: present");
		expect(result.text).toContain("config ok: socket /run/teez-phone/phone.sock");
		expect(result.text).toContain("proxmox.json: missing");
		expect(result.text).not.toContain("PRIVATE-VALUE");
	});

	it("fails an invalid port", () => {
		const result = checkConfig({ ...env, TEEZ_PHONE_PORT: "99999" });
		expect(result.ok).toBe(false);
		expect(result.text).toContain("TEEZ_PHONE_PORT is not a valid port");
	});

	it("fails a relative path", () => {
		const result = checkConfig({ ...env, TEEZ_PHONE_APP: "app" });
		expect(result.ok).toBe(false);
		expect(result.text).toContain("TEEZ_PHONE_APP must be an absolute path");
	});

	it("fails when the vault folder is not a git clone yet", async () => {
		await rm(path.join(vault, ".git"), { recursive: true });
		const result = checkConfig(env);
		expect(result.ok).toBe(false);
		expect(result.text).toContain(`TEEZ_PHONE_VAULT is not a git clone: ${vault}`);
	});
});
