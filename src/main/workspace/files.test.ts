import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory, readWorkspaceFile, writeWorkspaceFile, MAX_TEXT_BYTES } from "./files.ts";

describe("workspace files", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "teez-files-"));
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, "node_modules"));
		writeFileSync(join(root, "README.md"), "# hi\n");
		writeFileSync(join(root, "b.txt"), "b");
		writeFileSync(join(root, "src", "a.ts"), "export {}\n");
		writeFileSync(join(root, ".env"), "SECRET=1\n");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("lists folders first, hides .git, flags heavy folders", async () => {
		const result = await listDirectory(root, "");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
			"dir:node_modules",
			"dir:src",
			"file:.env",
			"file:b.txt",
			"file:README.md",
		]);
		expect(result.entries.find((e) => e.name === "node_modules")?.heavy).toBe(true);
		expect(result.entries.find((e) => e.name === "src")?.path).toBe("src");
	});

	test("lists a nested folder with workspace-relative paths", async () => {
		const result = await listDirectory(root, "src");
		expect(result.ok && result.entries.map((e) => e.path)).toEqual(["src/a.ts"]);
	});

	test("refuses to list outside the workspace", async () => {
		expect((await listDirectory(root, "..")).ok).toBe(false);
	});

	test("reads text with its size", async () => {
		const file = await readWorkspaceFile(root, "src/a.ts");
		expect(file).toEqual({ ok: true, kind: "text", content: "export {}\n", size: 10 });
	});

	test("binary files are not sent as text", async () => {
		writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
		const file = await readWorkspaceFile(root, "blob.bin");
		expect(file).toMatchObject({ ok: true, kind: "binary" });
	});

	test("images come back as a data URL", async () => {
		writeFileSync(join(root, "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const file = await readWorkspaceFile(root, "dot.png");
		expect(file).toMatchObject({ ok: true, kind: "image" });
		if (file.ok && file.kind === "image") {
			expect(file.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
		}
	});

	test("very large files are refused as text", async () => {
		writeFileSync(join(root, "big.log"), "x".repeat(MAX_TEXT_BYTES + 1));
		expect(await readWorkspaceFile(root, "big.log")).toMatchObject({ ok: true, kind: "too-large" });
	});

	test("writes an existing file inside the workspace", async () => {
		const result = await writeWorkspaceFile(root, "README.md", "# changed\n");
		expect(result.ok).toBe(true);
		expect(readFileSync(join(root, "README.md"), "utf-8")).toBe("# changed\n");
	});

	test("never writes outside", async () => {
		const result = await writeWorkspaceFile(root, "../escape.txt", "x");
		expect(result.ok).toBe(false);
	});

	test("a link pointing out of the workspace is refused", async () => {
		const outside = mkdtempSync(join(tmpdir(), "teez-outside-"));
		writeFileSync(join(outside, "secret.txt"), "s");
		try {
			// Junctions need no admin rights on Windows; symlinks may.
			symlinkSync(outside, join(root, "link"), "junction");
		} catch {
			rmSync(outside, { recursive: true, force: true });
			return; // the platform would not let us make one; nothing to test
		}
		try {
			expect((await readWorkspaceFile(root, "link/secret.txt")).ok).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
