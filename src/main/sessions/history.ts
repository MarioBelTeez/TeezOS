import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { EventConverter, type UiEvent } from "../claude/events.ts";

/**
 * Every Claude Code session ever run in a folder — from TeezAI, a terminal or
 * VS Code alike. Claude Code writes each one to
 * `~/.claude/projects/<folder with every non-alphanumeric as "-">/<id>.jsonl`;
 * reading those files is all it takes to list them and to show one again
 * before resuming it.
 */

export type SessionAgent = "claude" | "agy";

export type SessionSummary = {
	readonly id: string;
	readonly agent: SessionAgent;
	readonly title: string;
	readonly modified: number;
	readonly size: number;
};

export type HistoryItem = { readonly kind: "user"; readonly text: string } | UiEvent;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Title lookup reads only the head of each file; they can be tens of MB. */
const HEAD_LINES = 60;
const MAX_ITEMS = 400;

export function encodeProjectDir(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

async function findProjectDir(projectsRoot: string, cwd: string): Promise<string | null> {
	const wanted = encodeProjectDir(cwd).toLowerCase();
	try {
		const dirs = await readdir(projectsRoot, { withFileTypes: true });
		const match = dirs.find((d) => d.isDirectory() && d.name.toLowerCase() === wanted);
		return match ? join(projectsRoot, match.name) : null;
	} catch {
		return null;
	}
}

type Bag = Record<string, unknown>;
const isBag = (value: unknown): value is Bag => typeof value === "object" && value !== null;

function parse(line: string): Bag | null {
	try {
		const value: unknown = JSON.parse(line);
		return isBag(value) ? value : null;
	} catch {
		return null;
	}
}

/** The text a person typed, or null for tool results and injected context. */
function userText(entry: Bag): string | null {
	if (entry["type"] !== "user" || entry["isMeta"] === true) return null;
	const message = entry["message"];
	if (!isBag(message)) return null;
	const content = message["content"];
	let text = "";
	let images = 0;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		const parts = content.filter((part): part is Bag => isBag(part) && part["type"] === "text").map((part) => String(part["text"] ?? ""));
		text = parts.join("\n");
		images = content.filter((part) => isBag(part) && part["type"] === "image").length;
	}
	const trimmed = text.trim();
	// Slash commands, hook output and reminders arrive as user messages too.
	if (trimmed.startsWith("<")) return null;
	// A pasted image is not kept in the card, but where it was is.
	// (Claude Code's own terminal writes "[Image #1]" itself.)
	const marker = images > 0 && !/\[Image #\d+\]/.test(trimmed) ? `[${images} image${images === 1 ? "" : "s"}]` : "";
	return [trimmed, marker].filter(Boolean).join("\n") || null;
}

async function headOf(file: string): Promise<{ title: string | null; summary: string | null }> {
	const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	let title: string | null = null;
	let summary: string | null = null;
	let count = 0;
	try {
		for await (const raw of lines) {
			count += 1;
			const entry = parse(raw);
			if (entry?.["type"] === "summary" && typeof entry["summary"] === "string") summary ??= entry["summary"];
			if (!title && entry) title = userText(entry);
			if ((title && summary) || count >= HEAD_LINES) break;
		}
	} finally {
		lines.close();
	}
	return { title, summary };
}

export async function listSessions(projectsRoot: string, cwd: string, limit = 150): Promise<SessionSummary[]> {
	const dir = await findProjectDir(projectsRoot, cwd);
	if (!dir) return [];
	const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl") && SESSION_ID.test(name.slice(0, -6)));

	const withStats = await Promise.all(
		files.map(async (name) => {
			const info = await stat(join(dir, name));
			return { name, modified: info.mtimeMs, size: info.size };
		}),
	);
	withStats.sort((a, b) => b.modified - a.modified);

	const sessions: SessionSummary[] = [];
	for (const file of withStats.slice(0, limit)) {
		const { title, summary } = await headOf(join(dir, file.name));
		const label = (summary ?? title ?? "Untitled session").replace(/\s+/g, " ").trim();
		sessions.push({
			id: file.name.slice(0, -6),
			agent: "claude",
			title: label.length > 90 ? `${label.slice(0, 90)}…` : label,
			modified: Math.round(file.modified),
			size: file.size,
		});
	}
	return sessions;
}

/** A past session as the items a chat folds, newest MAX_ITEMS kept. */
export async function readTranscript(projectsRoot: string, cwd: string, sessionId: string): Promise<HistoryItem[]> {
	if (!SESSION_ID.test(sessionId)) return [];
	const dir = await findProjectDir(projectsRoot, cwd);
	if (!dir) return [];
	let raw: string;
	try {
		raw = await readFile(join(dir, `${sessionId}.jsonl`), "utf8");
	} catch {
		return [];
	}

	const converter = new EventConverter();
	const items: HistoryItem[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const entry = parse(line);
		if (!entry) continue;
		const text = userText(entry);
		if (text) {
			items.push({ kind: "user", text });
			continue;
		}
		if (entry["type"] !== "assistant" && entry["type"] !== "user") continue;
		for (const event of converter.push(entry)) {
			if (event.kind === "text" || event.kind === "tool-start" || event.kind === "tool-end") items.push(event);
		}
	}
	return items.slice(-MAX_ITEMS);
}

/**
 * Removes a past session: its `<id>.jsonl` and, when Claude Code made one,
 * the `<id>/` folder beside it (subagent transcripts, saved tool output).
 * `trash` decides where they go — the app passes the Recycle Bin, so a
 * delete can be undone. False when the id is not a session id or no such
 * session exists here; nothing is touched then. Throws when the file itself
 * cannot be moved (Windows: still open in a Claude process). The folder is
 * best effort: once the file is gone the session is gone, so a folder that
 * will not move does not turn a delete into a failure.
 */
export async function deleteSession(
	projectsRoot: string,
	cwd: string,
	sessionId: string,
	trash: (path: string) => Promise<void>,
): Promise<boolean> {
	if (!SESSION_ID.test(sessionId)) return false;
	const dir = await findProjectDir(projectsRoot, cwd);
	if (!dir) return false;
	const file = join(dir, `${sessionId}.jsonl`);
	try {
		if (!(await stat(file)).isFile()) return false;
	} catch {
		return false;
	}
	await trash(file);
	const folder = join(dir, sessionId);
	try {
		if ((await stat(folder)).isDirectory()) await trash(folder);
	} catch {
		// no side folder, or it would not move; the session itself is gone
	}
	return true;
}
