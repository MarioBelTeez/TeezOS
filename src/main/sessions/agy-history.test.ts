import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { deleteAgySession, extractAgyUserText, listAgySessions, readAgyTranscript } from "./agy-history.ts";

const line = (value: unknown): string => JSON.stringify(value);

describe("extractAgyUserText", () => {
	test("extracts prompt inside USER_REQUEST tags and strips metadata", () => {
		const raw = `<USER_REQUEST>\nfix the bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n2026-11-13\n</ADDITIONAL_METADATA>`;
		expect(extractAgyUserText(raw)).toBe("fix the bug");
	});

	test("falls back to plain text when no USER_REQUEST tags exist", () => {
		expect(extractAgyUserText("  hello world  ")).toBe("hello world");
	});
});

describe("agy session history", () => {
	let agyRoot: string;
	const cwd = resolve("C:\\Users\\user\\Documents\\TeezMind");
	const otherCwd = resolve("C:\\Users\\user\\Projects\\other");
	const id1 = "11111111-1111-4111-8111-111111111111";
	const id2 = "22222222-2222-4222-8222-222222222222";
	const idOther = "33333333-3333-4333-8333-333333333333";

	const writeTranscript = (id: string, lines: string[]): void => {
		const dir = join(agyRoot, "brain", id, ".system_generated", "logs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "transcript.jsonl"), lines.join("\n"));
	};

	beforeEach(() => {
		agyRoot = mkdtempSync(join(tmpdir(), "teez-agy-"));
		const db = new DatabaseSync(join(agyRoot, "conversation_summaries.db"));
		db.exec(`
			CREATE TABLE conversation_summaries (
				conversation_id text PRIMARY KEY,
				title text NOT NULL DEFAULT "",
				preview text NOT NULL DEFAULT "",
				step_count integer NOT NULL DEFAULT 0,
				last_modified_time datetime NOT NULL,
				workspace_uris text NOT NULL
			);
		`);
		const cwdUri = JSON.stringify([pathToFileURL(cwd).href]);
		const otherUri = JSON.stringify([pathToFileURL(otherCwd).href]);
		const insert = db.prepare(
			"INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris) VALUES (?, ?, ?, ?, ?, ?)",
		);
		insert.run(id1, "", "", 4, "2026-11-10T10:00:00Z", cwdUri);
		insert.run(id2, "TeezOS v0.3.18 release", "wrap up release", 10, "2026-11-13T14:00:00Z", cwdUri);
		insert.run(idOther, "Other project", "other", 5, "2026-11-13T15:00:00Z", otherUri);
		db.close();

		writeTranscript(id1, [
			line({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\ncheck the build\n</USER_REQUEST>" }),
			line({ step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }] }),
			line({ step_index: 2, type: "GENERIC", status: "DONE", content: "10 passed" }),
			line({ step_index: 3, type: "PLANNER_RESPONSE", content: "All tests pass." }),
		]);
		writeTranscript(id2, [line({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\nship 0.3.18\n</USER_REQUEST>" })]);
		writeTranscript(idOther, [line({ step_index: 0, type: "USER_INPUT", content: "hi" })]);
	});

	afterEach(() => rmSync(agyRoot, { recursive: true, force: true }));

	test("lists agy sessions for matching workspace newest first, using title or first user prompt", async () => {
		const sessions = await listAgySessions(agyRoot, cwd);
		expect(sessions.map((s) => [s.id, s.agent, s.title])).toEqual([
			[id2, "agy", "TeezOS v0.3.18 release"],
			[id1, "agy", "check the build"],
		]);
		expect(sessions[0]?.modified).toBe(new Date("2026-11-13T14:00:00Z").getTime());
	});

	test("returns empty list when db is missing", async () => {
		expect(await listAgySessions(join(agyRoot, "missing"), cwd)).toEqual([]);
	});

	test("reads transcript into user messages, tool cards, and assistant text", async () => {
		const items = await readAgyTranscript(agyRoot, id1);
		expect(items.map((i) => i.kind)).toEqual(["user", "tool-start", "tool-end", "text"]);
		expect(items[0]).toEqual({ kind: "user", text: "check the build" });
		expect(items[1]).toMatchObject({ kind: "tool-start", name: "run_command", input: { CommandLine: "npm test" } });
		expect(items[2]).toMatchObject({ kind: "tool-end", content: "10 passed", isError: false });
		expect(items[3]).toMatchObject({ kind: "text", text: "All tests pass." });
	});

	test("rejects invalid session ids", async () => {
		expect(await readAgyTranscript(agyRoot, "../../etc/passwd")).toEqual([]);
	});

	test("deleteAgySession trashes brain folder and .pb file", async () => {
		mkdirSync(join(agyRoot, "conversations"), { recursive: true });
		const pb = join(agyRoot, "conversations", `${id1}.pb`);
		writeFileSync(pb, "pb");

		const trashed: string[] = [];
		const ok = await deleteAgySession(agyRoot, id1, async (p) => {
			trashed.push(p);
			rmSync(p, { recursive: true, force: true });
		});
		expect(ok).toBe(true);
		expect(trashed).toEqual([join(agyRoot, "brain", id1), pb]);
		expect(existsSync(join(agyRoot, "brain", id1))).toBe(false);
		expect((await listAgySessions(agyRoot, cwd)).map((s) => s.id)).toEqual([id2]);
	});
});
