import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { downloadGate, formatBytes, isBlockedDownload, MAX_PENDING_DOWNLOADS, safeFileName, uniquePath, zoneIdentifier } from "./downloads.ts";

describe("downloadGate", () => {
	test("a download is asked about first; a blocked type is refused without asking", () => {
		expect(downloadGate("report.pdf", 0)).toEqual({ action: "ask" });
		expect(downloadGate("evil.url", 0)).toMatchObject({ action: "refuse", reason: expect.stringMatching(/file type/) });
	});
	test("at most three questions wait per tab; the fourth download is refused", () => {
		expect(MAX_PENDING_DOWNLOADS).toBe(3);
		expect(downloadGate("a.zip", 2)).toEqual({ action: "ask" });
		expect(downloadGate("a.zip", 3)).toMatchObject({ action: "refuse", reason: expect.stringMatching(/waiting/) });
		expect(downloadGate("a.zip", 9)).toMatchObject({ action: "refuse" });
	});
});

describe("zoneIdentifier", () => {
	test("Mark-of-the-Web: internet zone and the page the file came from", () => {
		expect(zoneIdentifier("https://example.com/files/report.pdf?x=1")).toBe("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.com/files/report.pdf?x=1\r\n");
	});
	test("credentials are dropped; anything that is not a web address is about:internet", () => {
		expect(zoneIdentifier("https://user:secret@example.com/a.zip")).toBe("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.com/a.zip\r\n");
		for (const url of ["blob:https://example.com/123", "data:text/plain,hi", "not a url", ""]) {
			expect(zoneIdentifier(url), url).toBe("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n");
		}
	});
	test("a URL can never add lines of its own", () => {
		const text = zoneIdentifier("https://example.com/a\r\nZoneId=0");
		expect(text.split("\r\n").filter((line) => line.startsWith("ZoneId="))).toEqual(["ZoneId=3"]);
	});
});

describe("formatBytes", () => {
	test("sizes for the confirm bar", () => {
		expect(formatBytes(0)).toBe("unknown size");
		expect(formatBytes(-1)).toBe("unknown size");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.0 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
		expect(formatBytes(3.5 * 1024 * 1024 * 1024)).toBe("3.5 GB");
	});
});

describe("safeFileName", () => {
	test("a server-chosen name cannot leave the folder", () => {
		expect(safeFileName("../../evil.exe")).toBe("evil.exe");
		expect(safeFileName("..\\..\\Windows\\evil.dll")).toBe("evil.dll");
		expect(safeFileName("C:\\x\\a.txt")).toBe("a.txt");
	});
	test("characters Windows refuses are replaced, reserved names and empties get a safe name", () => {
		expect(safeFileName('a<b>c:"d|e?f*.pdf')).toBe("a_b_c__d_e_f_.pdf");
		expect(safeFileName("CON.txt")).toBe("_CON.txt");
		expect(safeFileName("")).toBe("download");
		expect(safeFileName(" ..  ")).toBe("download");
		expect(safeFileName("report. ")).toBe("report");
	});
});

describe("uniquePath", () => {
	const dir = join("C:", "Users", "me", "Downloads");
	test("a free name is used as is", () => {
		expect(uniquePath(dir, "a.pdf", () => false)).toBe(join(dir, "a.pdf"));
	});
	test("a taken name gets a number before the extension", () => {
		const taken = new Set([join(dir, "a.pdf"), join(dir, "a (1).pdf")]);
		expect(uniquePath(dir, "a.pdf", (p) => taken.has(p))).toBe(join(dir, "a (2).pdf"));
		expect(uniquePath(dir, "README", (p) => p === join(dir, "README"))).toBe(join(dir, "README (1)"));
	});
});

describe("isBlockedDownload", () => {
	test("files Explorer parses or runs on sight are refused, whatever the case", () => {
		for (const name of ["a.library-ms", "x.searchConnector-ms", "Link.URL", "evil.scf", "doc.pdf.lnk", "app.HTA", "s.settingcontent-ms", "w.website", "d.desktop", "t.theme", "t.themepack", "q.search-ms"]) {
			expect(isBlockedDownload(name)).toBe(true);
		}
	});
	test("tricks that end up as a blocked type after cleaning are refused too", () => {
		expect(isBlockedDownload("evil.url.")).toBe(true);
		expect(isBlockedDownload("evil.url  ")).toBe(true);
		expect(isBlockedDownload("..\\x\\evil.scf")).toBe(true);
		// An NTFS stream name is flattened ("evil.url_hidden"), so it is no longer a .url file.
		expect(isBlockedDownload("evil.url:hidden")).toBe(false);
	});
	test("a bare dotfile of a blocked type is refused (Explorer reads \".url\" as a URL file)", () => {
		expect(isBlockedDownload(".url")).toBe(true);
		expect(isBlockedDownload(".LNK")).toBe(true);
		expect(isBlockedDownload(".library-ms")).toBe(true);
		expect(isBlockedDownload("dir/.scf")).toBe(true);
		expect(isBlockedDownload(".gitignore")).toBe(false);
	});
	test("ordinary files pass", () => {
		for (const name of ["report.pdf", "photo.jpg", "archive.zip", "notes.txt", "README", "url.txt", "scf"]) expect(isBlockedDownload(name)).toBe(false);
	});
});
