import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { safeStorage } from "electron";

/**
 * API tokens, encrypted with the OS keystore (DPAPI on Windows) and kept in
 * their own file next to the settings. They are read only in the main
 * process, when a request is made; the window is only ever told whether a
 * secret exists.
 */

export type SecretName = "proxmox" | "runner" | "update" | "groq" | "gemini";

export class SecretStore {
	constructor(readonly file: string) {}

	#read(): Record<string, string> {
		if (!existsSync(this.file)) return {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
		} catch {
			// Unreadable: report nothing, but #write refuses to replace it, so the
			// other secret in it is not silently lost.
			return {};
		}
	}

	#readable(): boolean {
		if (!existsSync(this.file)) return true;
		try {
			JSON.parse(readFileSync(this.file, "utf8"));
			return true;
		} catch {
			return false;
		}
	}

	#write(data: Record<string, string>): void {
		const temp = `${this.file}.tmp`;
		writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
		renameSync(temp, this.file);
	}

	has(name: SecretName): boolean {
		return typeof this.#read()[name] === "string";
	}

	get(name: SecretName): string | null {
		const stored = this.#read()[name];
		if (!stored) return null;
		try {
			return safeStorage.decryptString(Buffer.from(stored, "base64"));
		} catch {
			return null;
		}
	}

	set(name: SecretName, value: string): void {
		if (!safeStorage.isEncryptionAvailable()) {
			throw new Error("The system keystore is not available, so the secret was not saved.");
		}
		// On Linux without a keyring, Electron "encrypts" with a hard-coded key.
		if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
			throw new Error("No keyring (GNOME Keyring or KWallet) is running, so the secret was not saved.");
		}
		if (!this.#readable()) throw new Error(`${this.file} is damaged; move it aside before saving secrets.`);
		const data = this.#read();
		data[name] = safeStorage.encryptString(value).toString("base64");
		this.#write(data);
	}

	delete(name: SecretName): void {
		if (!this.#readable()) return;
		const data = this.#read();
		delete data[name];
		this.#write(data);
	}
}
