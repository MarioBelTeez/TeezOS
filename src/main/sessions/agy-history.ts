import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { HistoryItem, SessionSummary } from "./history.ts";

/**
 * Antigravity CLI (`agy`) stores session metadata in
 * `~/.gemini/antigravity-cli/conversation_summaries.db` and step transcripts in
 * `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`.
 */

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 400;

type Bag = Record<string, unknown>;
const isBag = (value: unknown): value is Bag => typeof value === "object" && value !== null && !Array.isArray(value);

export function normalizeWorkspaceUri(uri: string): string {
	let decoded = uri.trim();
	try {
		decoded = decodeURIComponent(decoded);
	} catch {
		// keep raw if malformed percent-encoding
	}
	decoded = decoded.replace(/\/+$/, "");
	return process.platform === "win32" ? decoded.toLowerCase() : decoded;
}

function workspaceMatches(workspaceUrisRaw: string, cwdUri: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(workspaceUrisRaw);
	} catch {
		return false;
	}
	if (!Array.isArray(parsed)) return false;
	return parsed.some((entry) => typeof entry === "string" && normalizeWorkspaceUri(entry) === cwdUri);
}

/** Extracts the user's prompt from `<USER_REQUEST>...</USER_REQUEST>` or raw text. */
export function extractAgyUserText(content: string): string | null {
	const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
	const raw = (match ? match[1] : content) ?? "";
	const cleaned = raw
		.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
		.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
		.trim();
	return cleaned || null;
}

function formatTitle(raw: string): string {
	const single = raw.replace(/\s+/g, " ").trim();
	if (!single) return "Untitled session";
	return single.length > 90 ? `${single.slice(0, 90)}…` : single;
}

function transcriptPath(agyRoot: string, sessionId: string): string {
	return join(agyRoot, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
}

async function firstUserTitle(file: string): Promise<string | null> {
	const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	let count = 0;
	try {
		for await (const raw of lines) {
			count += 1;
			if (!raw.trim()) continue;
			try {
				const entry: unknown = JSON.parse(raw);
				if (isBag(entry) && entry["type"] === "USER_INPUT" && typeof entry["content"] === "string") {
					const text = extractAgyUserText(entry["content"]);
					if (text) return text;
				}
			} catch {
				// ignore malformed line
			}
			if (count >= 20) break;
		}
	} catch {
		return null;
	} finally {
		lines.close();
	}
	return null;
}

type SummaryRow = {
	conversation_id: string;
	title: string;
	preview: string;
	last_modified_time: string;
	workspace_uris: string;
	step_count: number;
};

export async function listAgySessions(agyRoot: string, cwd: string, limit = 150): Promise<SessionSummary[]> {
	const dbPath = join(agyRoot, "conversation_summaries.db");
	let rows: SummaryRow[];
	let db: DatabaseSync | null = null;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
		rows = db
			.prepare(
				`SELECT conversation_id, title, preview, last_modified_time, workspace_uris, step_count
				 FROM conversation_summaries
				 ORDER BY last_modified_time DESC`,
			)
			.all() as SummaryRow[];
	} catch {
		return [];
	} finally {
		db?.close();
	}

	const cwdUri = normalizeWorkspaceUri(pathToFileURL(resolve(cwd)).href);
	const sessions: SessionSummary[] = [];

	for (const row of rows) {
		if (sessions.length >= limit) break;
		if (!SESSION_ID.test(row.conversation_id) || row.step_count <= 0) continue;
		if (!workspaceMatches(row.workspace_uris, cwdUri)) continue;

		const logFile = transcriptPath(agyRoot, row.conversation_id);
		let size = 0;
		try {
			const info = await stat(logFile);
			if (!info.isFile()) continue;
			size = info.size;
		} catch {
			// Skip conversations whose transcript folder was deleted or never created.
			continue;
		}

		const candidate = row.title.trim() || row.preview.trim() || (await firstUserTitle(logFile)) || "Untitled session";
		const modified = Date.parse(row.last_modified_time);
		sessions.push({
			id: row.conversation_id,
			agent: "agy",
			title: formatTitle(candidate),
			modified: Number.isFinite(modified) ? Math.round(modified) : 0,
			size,
		});
	}
	return sessions;
}

export async function readAgyTranscript(agyRoot: string, sessionId: string): Promise<HistoryItem[]> {
	if (!SESSION_ID.test(sessionId)) return [];
	let raw: string;
	try {
		raw = await readFile(transcriptPath(agyRoot, sessionId), "utf8");
	} catch {
		return [];
	}

	const items: HistoryItem[] = [];
	const pendingTools: string[] = [];

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isBag(entry)) continue;
		const type = entry["type"];

		if (type === "USER_INPUT" && typeof entry["content"] === "string") {
			const text = extractAgyUserText(entry["content"]);
			if (text) items.push({ kind: "user", text });
			continue;
		}

		if (type === "GENERIC" && pendingTools.length > 0) {
			const toolUseId = pendingTools.shift()!;
			const content = typeof entry["content"] === "string" ? entry["content"] : "";
			const isError = entry["status"] === "ERROR";
			items.push({ kind: "tool-end", sessionId, toolUseId, isError, content, parentToolUseId: null });
			continue;
		}

		if (type === "PLANNER_RESPONSE") {
			// Close any leftover tool calls before starting new ones.
			while (pendingTools.length > 0) {
				items.push({ kind: "tool-end", sessionId, toolUseId: pendingTools.shift()!, isError: false, content: "", parentToolUseId: null });
			}
			const step = typeof entry["step_index"] === "number" ? entry["step_index"] : items.length;
			const calls = entry["tool_calls"];
			if (Array.isArray(calls)) {
				calls.forEach((call, idx) => {
					if (!isBag(call) || typeof call["name"] !== "string") return;
					const toolUseId = `agy-${step}-${idx}`;
					const input = isBag(call["args"]) ? call["args"] : {};
					items.push({ kind: "tool-start", sessionId, toolUseId, name: call["name"], input, parentToolUseId: null });
					pendingTools.push(toolUseId);
				});
			}
			if (typeof entry["content"] === "string" && entry["content"].trim()) {
				while (pendingTools.length > 0) {
					items.push({ kind: "tool-end", sessionId, toolUseId: pendingTools.shift()!, isError: false, content: "", parentToolUseId: null });
				}
				items.push({ kind: "text", sessionId, text: entry["content"] });
			}
		}
	}

	while (pendingTools.length > 0) {
		items.push({ kind: "tool-end", sessionId, toolUseId: pendingTools.shift()!, isError: false, content: "", parentToolUseId: null });
	}

	return items.slice(-MAX_ITEMS);
}

/**
 * Moves an Antigravity conversation's `brain/<id>` folder (and `.pb` file if
 * present) to the Recycle Bin.
 */
export async function deleteAgySession(
	agyRoot: string,
	sessionId: string,
	trash: (path: string) => Promise<void>,
): Promise<boolean> {
	if (!SESSION_ID.test(sessionId)) return false;
	const brainDir = join(agyRoot, "brain", sessionId);
	const pbFile = join(agyRoot, "conversations", `${sessionId}.pb`);
	let existed = false;

	try {
		if ((await stat(brainDir)).isDirectory()) {
			await trash(brainDir);
			existed = true;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	try {
		if ((await stat(pbFile)).isFile()) {
			await trash(pbFile);
			existed = true;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	return existed;
}
