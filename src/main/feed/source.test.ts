import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileFn, htmlToText, isPublicAddress, locatePython, locateWatchScript, readSource, type ExecFn, type SourceDeps } from "./source.ts";
import { newItem, type FeedItem } from "../../shared/feed.ts";

let work: string;
beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "feed-source-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

type Call = { file: string; args: readonly string[]; options: Parameters<ExecFn>[2] };

function deps(overrides: Partial<SourceDeps> = {}): { deps: SourceDeps; calls: Call[] } {
	const calls: Call[] = [];
	const base: SourceDeps = {
		exec: async (file, args, options) => {
			calls.push({ file, args, options });
			return { ok: true, stdout: "# watch: video report\n## Transcript\nhello", stderr: "" };
		},
		fetch: async () => new Response("<html><title>T</title><body><p>Body text</p></body></html>", { headers: { "content-type": "text/html" } }),
		python: () => "C:\\Python314\\python.exe",
		watchScript: () => "C:\\plugins\\watch\\0.1.3\\scripts\\watch.py",
		defuddle: () => null,
		lookup: async () => ["93.184.216.34"],
		env: { PATH: "C:\\bin" },
		...overrides,
	};
	return { deps: base, calls };
}

const item = (source: string): FeedItem => newItem("job-1", source, "auto", "", 1)!;

describe("readSource", () => {
	test("a video runs watch.py with a fixed argv, the Groq key in env, and output in the job's folder", async () => {
		const { deps: d, calls } = deps();
		const result = await readSource(item("https://youtu.be/abc"), work, "gsk_k", d);
		expect(result).toMatchObject({ ok: true, text: expect.stringContaining("hello") });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.file).toBe("C:\\Python314\\python.exe");
		expect(calls[0]!.args).toEqual(["-I", "-X", "utf8", "C:\\plugins\\watch\\0.1.3\\scripts\\watch.py", "--out-dir", work, "--", "https://youtu.be/abc"]);
		expect(calls[0]!.options.cwd).toBe(work);
		expect(calls[0]!.options.env["GROQ_API_KEY"]).toBe("gsk_k");
		expect(calls[0]!.options).not.toHaveProperty("shell");
	});
	test("a local video file goes through the same script; no key, no env var", async () => {
		const { deps: d, calls } = deps();
		await readSource(item("C:\\Videos\\talk.mkv"), work, null, d);
		expect(calls[0]!.args.at(-1)).toBe("C:\\Videos\\talk.mkv");
		expect(calls[0]!.options.env["GROQ_API_KEY"]).toBeUndefined();
	});
	test("video errors come back as text, never thrown", async () => {
		expect(await readSource(item("https://youtu.be/a"), work, null, deps({ watchScript: () => null }).deps)).toMatchObject({ ok: false, error: expect.stringMatching(/watch/) });
		expect(await readSource(item("https://youtu.be/a"), work, null, deps({ python: () => null }).deps)).toMatchObject({ ok: false, error: expect.stringMatching(/Python/) });
		const failing = deps({ exec: async () => ({ ok: false, stdout: "", stderr: "yt-dlp: unavailable" }) }).deps;
		expect(await readSource(item("https://youtu.be/a"), work, null, failing)).toMatchObject({ ok: false, error: expect.stringContaining("yt-dlp") });
		const throwing = deps({ exec: async () => { throw new Error("spawn failed"); } }).deps;
		expect(await readSource(item("https://youtu.be/a"), work, null, throwing)).toMatchObject({ ok: false, error: expect.stringContaining("spawn failed") });
	});
	test("a video link whose host is on the local network never reaches yt-dlp", async () => {
		for (const address of ["127.0.0.1", "192.168.1.1", "169.254.169.254", "::1"]) {
			const looked: string[] = [];
			const { deps: d, calls } = deps({
				lookup: async (host) => {
					looked.push(host);
					return [address];
				},
			});
			const result = await readSource(item("https://youtu.be/abc"), work, null, d);
			expect(result, address).toMatchObject({ ok: false, error: expect.stringMatching(/local network/) });
			expect(looked).toEqual(["youtu.be"]);
			expect(calls, address).toHaveLength(0);
		}
		const unresolved = deps({ lookup: async () => Promise.reject(new Error("ENOTFOUND")) });
		expect(await readSource(item("https://youtu.be/abc"), work, null, unresolved.deps)).toMatchObject({ ok: false });
		expect(unresolved.calls).toHaveLength(0);
	});
	test("a public video link is checked once, then read; a local video file needs no lookup", async () => {
		const looked: string[] = [];
		const { deps: d, calls } = deps({
			lookup: async (host) => {
				looked.push(host);
				return ["142.250.180.14"];
			},
		});
		expect(await readSource(item("https://www.youtube.com/watch?v=abc"), work, null, d)).toMatchObject({ ok: true });
		expect(looked).toEqual(["www.youtube.com"]);
		expect(calls).toHaveLength(1);
		looked.length = 0;
		await readSource(item("C:\\Videos\\talk.mkv"), work, null, d);
		expect(looked).toEqual([]);
	});
	test("an article is fetched here (checked), then handed to defuddle as a file, with a fixed argv", async () => {
		const fetched: string[] = [];
		const { deps: d, calls } = deps({
			defuddle: () => "C:\\bin\\defuddle.exe",
			fetch: async (url) => {
				fetched.push(String(url));
				return new Response("<html><body><p>page</p></body></html>", { headers: { "content-type": "text/html" } });
			},
			exec: async (file, args, options) => {
				calls.push({ file, args, options });
				return { ok: true, stdout: "# Clean article", stderr: "" };
			},
		});
		const result = await readSource(item("https://example.com/post"), work, "gsk_k", d);
		expect(result).toEqual({ ok: true, text: "# Clean article" });
		expect(fetched).toEqual(["https://example.com/post"]);
		expect(calls[0]!.args).toEqual(["parse", join(work, "source.html"), "--md"]);
		expect(readFileSync(join(work, "source.html"), "utf8")).toContain("page");
		expect(calls[0]!.options.env["GROQ_API_KEY"]).toBeUndefined();
	});
	test("defuddle failing falls back to the plain converter", async () => {
		const { deps: d } = deps({ defuddle: () => "C:\\bin\\defuddle.exe", exec: async () => ({ ok: false, stdout: "", stderr: "bad" }) });
		const result = await readSource(item("https://example.com/post"), work, null, d);
		expect(result).toMatchObject({ ok: true, text: expect.stringContaining("Body text") });
	});
	test("without defuddle an article is fetched and turned into text", async () => {
		const seen: string[] = [];
		const { deps: d } = deps({
			fetch: async (url) => {
				seen.push(String(url));
				return new Response("<html><head><title>My Post</title><script>evil()</script></head><body><h2>Part</h2><p>Hello &amp; welcome</p></body></html>", {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			},
		});
		const result = await readSource(item("https://example.com/post"), work, null, d);
		expect(seen).toEqual(["https://example.com/post"]);
		expect(result.ok && result.text).toContain("My Post");
		expect(result.ok && result.text).toContain("Hello & welcome");
		expect(result.ok && result.text).not.toContain("evil()");
	});
	test("an article that is too big or not http is refused", async () => {
		const huge = deps({ fetch: async () => new Response("x".repeat(6 * 1024 * 1024), { headers: { "content-type": "text/html" } }) }).deps;
		expect(await readSource(item("https://example.com/post"), work, null, huge)).toMatchObject({ ok: false });
		const redirected = deps({ fetch: async () => new Response(null, { status: 302, headers: { location: "file:///C:/secret.txt" } }) }).deps;
		expect(await readSource(item("https://example.com/post"), work, null, redirected)).toMatchObject({ ok: false });
	});
	test("local-network addresses are refused, for the link and for every redirect", async () => {
		const inits: RequestInit[] = [];
		const loopback = deps({ lookup: async () => ["127.0.0.1"] }).deps;
		expect(await readSource(item("http://localhost:8080/admin"), work, null, loopback)).toMatchObject({ ok: false, error: expect.stringMatching(/local network/) });
		const hops: string[] = [];
		const toMetadata = deps({
			lookup: async (host) => (host === "169.254.169.254" ? ["169.254.169.254"] : ["93.184.216.34"]),
			fetch: async (url, init) => {
				hops.push(url);
				inits.push(init);
				return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
			},
		}).deps;
		expect(await readSource(item("https://example.com/post"), work, null, toMetadata)).toMatchObject({ ok: false, error: expect.stringMatching(/local network/) });
		expect(hops).toEqual(["https://example.com/post"]);
		expect(inits[0]!.redirect).toBe("manual");
		const loop = deps({ fetch: async (url) => new Response(null, { status: 301, headers: { location: `${url}x` } }) }).deps;
		expect(await readSource(item("https://example.com/post"), work, null, loop)).toMatchObject({ ok: false, error: expect.stringMatching(/redirect/i) });
		const unresolvable = deps({ lookup: async () => { throw new Error("ENOTFOUND"); } }).deps;
		expect(await readSource(item("https://nowhere.invalid/"), work, null, unresolvable)).toMatchObject({ ok: false });
	});
	test("a redirect to a public page is followed", async () => {
		const hops: string[] = [];
		const { deps: d } = deps({
			fetch: async (url) => {
				hops.push(url);
				return hops.length === 1
					? new Response(null, { status: 301, headers: { location: "/moved" } })
					: new Response("<p>Moved here</p>", { headers: { "content-type": "text/html" } });
			},
		});
		expect(await readSource(item("https://example.com/post"), work, null, d)).toMatchObject({ ok: true, text: expect.stringContaining("Moved here") });
		expect(hops).toEqual(["https://example.com/post", "https://example.com/moved"]);
	});
	test("the job's abort signal reaches the process and the download", async () => {
		const controller = new AbortController();
		const { deps: d, calls } = deps();
		await readSource(item("https://youtu.be/a"), work, null, d, controller.signal);
		expect(calls[0]!.options.signal).toBe(controller.signal);
		const seen: (AbortSignal | null | undefined)[] = [];
		const fetching = deps({
			fetch: async (_url, init) => {
				seen.push(init.signal);
				return new Response("<p>x</p>", { headers: { "content-type": "text/html" } });
			},
		}).deps;
		controller.abort();
		expect(await readSource(item("https://example.com/post"), work, null, fetching, controller.signal)).toMatchObject({ ok: false });
		expect(seen.every((s) => s?.aborted !== false)).toBe(true);
	});
	test("a PDF link is downloaded and returned as bytes", async () => {
		const { deps: d } = deps({ fetch: async () => new Response("%PDF-1.7 fake", { headers: { "content-type": "application/pdf" } }) });
		const result = await readSource(item("https://example.com/paper.pdf"), work, null, d);
		expect(result.ok && result.pdf && Buffer.from(result.pdf).toString("utf8")).toBe("%PDF-1.7 fake");
		expect(existsSync(join(work, "source.pdf"))).toBe(false);
	});
	test("a local PDF is read as bytes; a missing or non-PDF file is refused", async () => {
		const outside = mkdtempSync(join(tmpdir(), "feed-pdf-"));
		try {
			writeFileSync(join(outside, "spec.pdf"), "%PDF-1.4 local");
			writeFileSync(join(outside, "fake.pdf"), "not a pdf");
			const ok = await readSource(item(join(outside, "spec.pdf")), work, null, deps().deps);
			expect(ok.ok && ok.pdf && Buffer.from(ok.pdf).toString("utf8")).toBe("%PDF-1.4 local");
			expect((await readSource(item(join(outside, "missing.pdf")), work, null, deps().deps)).ok).toBe(false);
			expect((await readSource(item(join(outside, "fake.pdf")), work, null, deps().deps)).ok).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("locators", () => {
	test("the highest installed watch version wins", () => {
		const home = mkdtempSync(join(tmpdir(), "feed-home-"));
		try {
			for (const version of ["0.1.3", "0.10.0", "0.2.0"]) {
				mkdirSync(join(home, ".claude", "plugins", "cache", "claude-video", "watch", version, "scripts"), { recursive: true });
				writeFileSync(join(home, ".claude", "plugins", "cache", "claude-video", "watch", version, "scripts", "watch.py"), "");
			}
			expect(locateWatchScript(home)).toBe(join(home, ".claude", "plugins", "cache", "claude-video", "watch", "0.10.0", "scripts", "watch.py"));
			expect(existsSync(locateWatchScript(home)!)).toBe(true);
			expect(locateWatchScript(join(home, "nowhere"))).toBeNull();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
	test("python: a real python.exe on PATH, never the Store stub", () => {
		const files = new Set(["C:\\Users\\r\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe", "C:\\Python314\\python.exe"]);
		const entries = ["C:\\Users\\r\\AppData\\Local\\Microsoft\\WindowsApps", "C:\\Python314"];
		expect(locatePython("win32", entries, (p) => files.has(p))).toBe("C:\\Python314\\python.exe");
		expect(locatePython("win32", entries.slice(0, 1), (p) => files.has(p))).toBeNull();
		expect(locatePython("linux", ["/usr/bin"], (p) => p === "/usr/bin/python3")).toBe("/usr/bin/python3");
	});
	test("htmlToText keeps headings, paragraphs and entities, drops scripts and styles", () => {
		const text = htmlToText("<title>A &lt;b&gt;</title><style>p{}</style><h1>Big</h1><p>One<br>Two &#8212; three</p><ul><li>x</li></ul>");
		expect(text).toContain("A <b>");
		expect(text).toContain("# Big");
		expect(text).toContain("One\nTwo \u2014 three");
		expect(text).toContain("- x");
		expect(text).not.toContain("p{}");
	});
	test("htmlToText is linear: a megabyte of unclosed openers converts in well under a second", () => {
		for (const html of ["<nav ".repeat(200_000), "<script>".repeat(125_000), "<nav>x".repeat(170_000), "<".repeat(1_000_000)]) {
			const started = performance.now();
			htmlToText(html);
			expect(performance.now() - started).toBeLessThan(1000);
		}
	});
	test("htmlToText still drops a closed script that comes after unclosed ones; Unicode keeps indices aligned", () => {
		const text = htmlToText("<p>keep</p><nav <p>open nav<script>secret()</script><p>also İstanbul</p>");
		expect(text).toContain("keep");
		expect(text).toContain("open nav");
		expect(text).toContain("also İstanbul");
		expect(text).not.toContain("secret()");
	});
});

describe("isPublicAddress", () => {
	test("refuses loopback, private, link-local, CGNAT, multicast and unspecified", () => {
		for (const ip of ["127.0.0.1", "127.5.5.5", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip"]) {
			expect(isPublicAddress(ip), ip).toBe(false);
		}
	});
	test("accepts ordinary public addresses", () => {
		for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
	});
});

describe("execFileFn", () => {
	test("abort kills the process (tree) at once", async () => {
		const controller = new AbortController();
		const started = performance.now();
		const running = execFileFn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: tmpdir(), env: process.env, timeoutMs: 120_000, signal: controller.signal });
		setTimeout(() => controller.abort(), 300);
		const result = await running;
		expect(result.ok).toBe(false);
		expect(performance.now() - started).toBeLessThan(15_000);
	}, 20_000);
	test("an already aborted signal never starts the process", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await execFileFn(process.execPath, ["-e", "1"], { cwd: tmpdir(), env: process.env, timeoutMs: 10_000, signal: controller.signal });
		expect(result.ok).toBe(false);
	});
});
