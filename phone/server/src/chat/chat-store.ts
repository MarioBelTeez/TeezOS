import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Card } from "../../../../src/renderer/chat/reduce.ts";

export type Engine = "agy" | "claude";

export type StoredChat = {
	id: string;
	title: string;
	engine: Engine;
	effort: string;
	/** The agent's own conversation id (agy) or session id (claude); "" until the first reply. */
	conversationId: string;
	cards: Card[];
	createdAt: number;
	updatedAt: number;
};

export type ChatSummary = Pick<StoredChat, "id" | "title" | "engine" | "createdAt" | "updatedAt">;

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Chat ids are random UUIDs; anything else is never a file name. */
export function isChatId(value: string): boolean {
	return CHAT_ID.test(value);
}

/** Phone chats, one JSON file each under `dataDir/chats`, written through a temp file and a rename. */
export class ChatStore {
	readonly #dir: string;

	constructor(dataDir: string) {
		this.#dir = path.join(dataDir, "chats");
	}

	#file(id: string): string {
		if (!isChatId(id)) throw new Error(`not a chat id: ${id}`);
		return path.join(this.#dir, `${id}.json`);
	}

	#read(file: string): StoredChat | null {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		try {
			const parsed = JSON.parse(raw) as StoredChat;
			return typeof parsed === "object" && parsed !== null && isChatId(parsed.id) && Array.isArray(parsed.cards) ? parsed : null;
		} catch {
			console.error(`phone: chat file is corrupt, skipped: ${file}`);
			return null;
		}
	}

	get(id: string): StoredChat | null {
		return isChatId(id) ? this.#read(this.#file(id)) : null;
	}

	list(): ChatSummary[] {
		let names: string[];
		try {
			names = readdirSync(this.#dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return names
			.filter((name) => name.endsWith(".json") && isChatId(name.slice(0, -5)))
			.map((name) => this.#read(path.join(this.#dir, name)))
			.filter((chat): chat is StoredChat => chat !== null)
			.map(({ id, title, engine, createdAt, updatedAt }) => ({ id, title, engine, createdAt, updatedAt }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	save(chat: StoredChat): void {
		const file = this.#file(chat.id);
		mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
		const temp = `${file}.tmp`;
		writeFileSync(temp, JSON.stringify(chat), { encoding: "utf8", mode: 0o600 });
		renameSync(temp, file);
	}
}
