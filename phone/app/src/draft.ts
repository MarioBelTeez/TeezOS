import type { ApiResult } from "./api.ts";

/**
 * The composer's text, kept until the server has it. A send that fails
 * (offline, server down, a refusal) leaves the draft exactly as it was, and
 * the draft lives in storage, so closing the app mid-thought loses nothing.
 * Text typed while a send is in flight is kept too: only the sent text clears.
 */

export type DraftStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};

export type Draft = {
	text(): string;
	set(text: string): void;
	send(post: (text: string) => Promise<ApiResult<unknown>>): Promise<ApiResult<unknown>>;
};

const PREFIX = "teez-draft:";

export function memoryStorage(): DraftStorage {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => void values.set(key, value),
		removeItem: (key) => void values.delete(key),
	};
}

/** localStorage when it works (private mode can refuse it), else memory. */
export function browserStorage(): DraftStorage {
	try {
		const probe = `${PREFIX}probe`;
		localStorage.setItem(probe, "1");
		localStorage.removeItem(probe);
		return localStorage;
	} catch {
		return memoryStorage();
	}
}

export function createDraft(storage: DraftStorage, name: string): Draft {
	const key = PREFIX + name;
	const read = (): string => {
		try {
			return storage.getItem(key) ?? "";
		} catch {
			return "";
		}
	};
	const write = (text: string): void => {
		try {
			if (text === "") storage.removeItem(key);
			else storage.setItem(key, text);
		} catch {
			// Storage full or refused: the draft still lives in the composer.
		}
	};

	return {
		text: read,
		set: write,
		async send(post) {
			const sent = read();
			if (sent.trim() === "") return { ok: false, error: "Nothing to send.", offline: false };
			let result: ApiResult<unknown>;
			try {
				result = await post(sent.trim());
			} catch (error) {
				result = { ok: false, error: error instanceof Error ? error.message : String(error), offline: false };
			}
			if (result.ok && read() === sent) write("");
			return result;
		},
	};
}
