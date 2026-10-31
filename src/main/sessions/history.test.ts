import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession, encodeProjectDir, listSessions, readTranscript } from "./history.ts";

const line = (value: unknown): string => JSON.stringify(value);

describe("encodeProjectDir", () => {
	test("matches Claude Code's folder naming", () => {
		expect(encodeProjectDir("C:\\Users\\user\\TeezMind")).toBe("C--Users-user-TeezMind");
		expect(encodeProjectDir("/home/user/a b")).toBe("-home-user-a-b");
	});
});

describe("session history", () => {
	let projects: string;
	const cwd = "C:\\Users\\user\\TeezMind";
	const id1 = "11111111-1111-4111-8111-111111111111";
	const id2 = "22222222-2222-4222-8222-222222222222";

	beforeEach(() => {
		projects = mkdtempSync(join(tmpdir(), "teez-projects-"));
		// VS Code writes the drive letter in lower case; the lookup must not care.
		const dir = join(projects, "c--Users-user-TeezMind");
		mkdirSync(dir);
		writeFileSync(
			join(dir, `${id1}.jsonl`),
			[
				line({ type: "user", message: { role: "user", content: "<command-name>/effort</command-name>" } }),
				line({ type: "user", message: { role: "user", content: "fix the   server note" }, timestamp: "2026-10-09T10:00:00Z" }),
				line({
					type: "assistant",
					message: {
						content: [
							{ type: "text", text: "Reading it." },
							{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.md" } },
						],
					},
				}),
				line({
					type: "user",
					message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "the note" }] },
				}),
				line({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }),
				line({
					type: "user",
					message: {
						role: "user",
						content: [
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
							{ type: "text", text: "and this?" },
						],
					},
				}),
				line({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] } }),
				// The CLI writes its own placeholder next to a pasted image.
				line({
					type: "user",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "[Image #1] fix this" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
						],
					},
				}),
				"not json at all",
			].join("\n"),
		);
		writeFileSync(
			join(dir, `${id2}.jsonl`),
			[
				line({ type: "summary", summary: "Lead in Beauty launch" }),
				line({ type: "user", message: { role: "user", content: [{ type: "text", text: "go live" }] } }),
			].join("\n"),
		);
		utimesSync(join(dir, `${id1}.jsonl`), new Date("2026-10-01"), new Date("2026-10-01"));
		utimesSync(join(dir, `${id2}.jsonl`), new Date("2026-10-09"), new Date("2026-10-09"));
		writeFileSync(join(dir, "notes.txt"), "ignore me");
	});

	afterEach(() => rmSync(projects, { recursive: true, force: true }));

	test("lists sessions newest first, titled by summary or first real message", async () => {
		const sessions = await listSessions(projects, cwd);
		expect(sessions.map((s) => [s.id, s.title])).toEqual([
			[id2, "Lead in Beauty launch"],
			[id1, "fix the server note"],
		]);
		expect(sessions[0]?.modified).toBe(new Date("2026-10-09").getTime());
	});

	test("an unknown folder has no sessions", async () => {
		expect(await listSessions(projects, "D:\\nothing")).toEqual([]);
	});

	test("a transcript becomes user messages and the same events a live chat gets", async () => {
		const items = await readTranscript(projects, cwd, id1);
		expect(items.map((i) => i.kind)).toEqual(["user", "text", "tool-start", "tool-end", "text", "user", "user", "user"]);
		expect(items[0]).toMatchObject({ kind: "user", text: "fix the   server note" });
		// Pasted images are not kept in the card, but their place is.
		expect(items[5]).toMatchObject({ kind: "user", text: "and this?\n[1 image]" });
		expect(items[6]).toMatchObject({ kind: "user", text: "[1 image]" });
		expect(items[7]).toMatchObject({ kind: "user", text: "[Image #1] fix this" });
		expect(items[3]).toMatchObject({ kind: "tool-end", toolUseId: "t1", content: "the note" });
	});

	test("ids that are not session ids are refused (no path tricks)", async () => {
		expect(await readTranscript(projects, cwd, "../../etc/passwd")).toEqual([]);
	});
	describe("deleteSession", () => {
		const trashed: string[] = [];
		const trash = async (path: string): Promise<void> => {
			trashed.push(path);
			rmSync(path, { recursive: true, force: true });
		};
		beforeEach(() => {
			trashed.length = 0;
		});

		test("sends the session file and its side folder to the trash", async () => {
			const dir = join(projects, "c--Users-user-TeezMind");
			mkdirSync(join(dir, id1, "subagents"), { recursive: true });
			expect(await deleteSession(projects, cwd, id1, trash)).toBe(true);
			expect(trashed).toEqual([join(dir, `${id1}.jsonl`), join(dir, id1)]);
			expect(existsSync(join(dir, `${id1}.jsonl`))).toBe(false);
			expect((await listSessions(projects, cwd)).map((s) => s.id)).toEqual([id2]);
		});

		test("without a side folder only the file goes", async () => {
			expect(await deleteSession(projects, cwd, id2, trash)).toBe(true);
			expect(trashed).toHaveLength(1);
		});

		test("a side folder that will not move does not fail the delete", async () => {
			const dir = join(projects, "c--Users-user-TeezMind");
			mkdirSync(join(dir, id1));
			const stubborn = async (path: string): Promise<void> => {
				if (!path.endsWith(".jsonl")) throw new Error("EBUSY");
				await trash(path);
			};
			expect(await deleteSession(projects, cwd, id1, stubborn)).toBe(true);
		});

		test("a file that will not move is an error, not a silent false", async () => {
			const locked = async (): Promise<void> => {
				throw new Error("EBUSY");
			};
			await expect(deleteSession(projects, cwd, id1, locked)).rejects.toThrow("EBUSY");
		});

		test("refuses anything that is not a session id, and unknown sessions", async () => {
			expect(await deleteSession(projects, cwd, "../../etc/passwd", trash)).toBe(false);
			expect(await deleteSession(projects, cwd, "notes", trash)).toBe(false);
			expect(await deleteSession(projects, cwd, "33333333-3333-4333-8333-333333333333", trash)).toBe(false);
			expect(await deleteSession(projects, "D:\nothing", id1, trash)).toBe(false);
			expect(trashed).toEqual([]);
		});
	});
});
