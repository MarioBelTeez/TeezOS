import { describe, test, expect } from "vitest";
import { resolveUpdateConfig, TOKEN_FILE_NAME, isGithubToken, checkReleaseAccess } from "./update-config.ts";
import type { UpdateEnvironment } from "./update-config.ts";

/**
 * TeezAI's repository is private, so electron-updater needs a credential to
 * read its releases. It must never be a bundled one: an installer's asar is
 * trivially unpacked, so a baked-in token is a published token.
 *
 * The token therefore arrives at runtime — from the environment, or from a
 * file in the app's own data folder that the user writes once. Without one the
 * updater stays off and the app works exactly as before.
 */

const environment = (over: Partial<UpdateEnvironment> = {}): UpdateEnvironment => ({
	isPackaged: true,
	env: {},
	readTokenFile: () => null,
	...over,
});

describe("resolveUpdateConfig", () => {
	test("a development run never updates itself", () => {
		const config = resolveUpdateConfig(
			environment({ isPackaged: false, env: { TEEZAI_UPDATE_TOKEN: "ghp_secret" } }),
		);
		expect(config.enabled).toBe(false);
		if (!config.enabled) expect(config.reason).toMatch(/installed build/i);
	});

	test("the app's own variable supplies the token", () => {
		const config = resolveUpdateConfig(
			environment({ env: { TEEZAI_UPDATE_TOKEN: "ghp_from_env" } }),
		);
		expect(config).toEqual({ enabled: true, token: "ghp_from_env" });
	});

	test("GH_TOKEN works too, for a shell that already has one", () => {
		const config = resolveUpdateConfig(environment({ env: { GH_TOKEN: "ghp_shell" } }));
		expect(config).toEqual({ enabled: true, token: "ghp_shell" });
	});

	test("the app's own variable wins over the general one", () => {
		const config = resolveUpdateConfig(
			environment({ env: { TEEZAI_UPDATE_TOKEN: "ghp_mine", GH_TOKEN: "ghp_shell" } }),
		);
		expect(config).toEqual({ enabled: true, token: "ghp_mine" });
	});

	test("a token file in the app's data folder is read when the environment is bare", () => {
		const config = resolveUpdateConfig(
			environment({ readTokenFile: () => "ghp_from_file\n" }),
		);
		expect(config).toEqual({ enabled: true, token: "ghp_from_file" });
	});

	test("a token saved in Settings is used before the file", () => {
		const config = resolveUpdateConfig(
			environment({ readStoredToken: () => "ghp_saved", readTokenFile: () => "ghp_from_file" }),
		);
		expect(config).toEqual({ enabled: true, token: "ghp_saved" });
	});

	test("a saved token wins over a general GH_TOKEN (a developer's broad one)", () => {
		const config = resolveUpdateConfig(
			environment({ env: { GH_TOKEN: "ghp_broad" }, readStoredToken: () => "github_pat_saved" }),
		);
		expect(config).toEqual({ enabled: true, token: "github_pat_saved" });
	});

	test("the environment still wins over a saved token", () => {
		const config = resolveUpdateConfig(
			environment({ env: { TEEZAI_UPDATE_TOKEN: "ghp_env" }, readStoredToken: () => "ghp_saved" }),
		);
		expect(config).toEqual({ enabled: true, token: "ghp_env" });
	});

	test("a blank or whitespace-only token counts as no token", () => {
		for (const blank of ["", "   ", "\n"]) {
			const config = resolveUpdateConfig(
				environment({ env: { TEEZAI_UPDATE_TOKEN: blank } }),
			);
			expect(config.enabled).toBe(false);
		}
	});

	test("without a token the updater stays off and says how to turn it on", () => {
		const config = resolveUpdateConfig(environment());
		expect(config.enabled).toBe(false);
		if (!config.enabled) {
			expect(config.reason).toContain(TOKEN_FILE_NAME);
			expect(config.reason).toMatch(/Settings/);
			expect(config.reason).toMatch(/read-only/i);
		}
	});

	test("the reason never repeats the token back", () => {
		// Whatever goes wrong, the explanation ends up in a log file.
		const config = resolveUpdateConfig(
			environment({ isPackaged: false, env: { TEEZAI_UPDATE_TOKEN: "ghp_topsecret" } }),
		);
		if (!config.enabled) expect(config.reason).not.toContain("ghp_topsecret");
	});
});

describe("isGithubToken", () => {
	test("accepts the shapes GitHub issues", () => {
		expect(isGithubToken("ghp_" + "a".repeat(36))).toBe(true);
		expect(isGithubToken("github_pat_" + "A1_".repeat(25))).toBe(true);
	});

	test.each([[""], ["short"], ["ghp_with space " + "a".repeat(30)], ["ghp_" + "a".repeat(300)], ["ghp_\nnewline" + "a".repeat(30)]])(
		"refuses %j",
		(value) => {
			expect(isGithubToken(value)).toBe(false);
		},
	);
});

describe("checkReleaseAccess", () => {
	const reply = (status: number) => async () => new Response("{}", { status });

	test("asks GitHub for TeezAI's releases with the token", async () => {
		let seen: { url: string; auth: string | null } | null = null;
		const result = await checkReleaseAccess("ghp_x", async (url, init) => {
			seen = { url: String(url), auth: new Headers(init?.headers).get("authorization") };
			return new Response("[]", { status: 200 });
		});
		expect(result).toEqual({ ok: true });
		expect(seen).toEqual({ url: "https://api.github.com/repos/MarioBelTeez/TeezAI/releases?per_page=1", auth: "Bearer ghp_x" });
	});

	test("a classic token is refused: one that can read a private repository can also write to it", async () => {
		const result = await checkReleaseAccess("ghp_x", async () => new Response("[]", { status: 200, headers: { "x-oauth-scopes": "repo, read:org" } }));
		expect(result).toEqual({ ok: false, message: expect.stringMatching(/fine-grained/) });
	});

	test("explains a refused token and one that cannot see the repository", async () => {
		expect(await checkReleaseAccess("ghp_x", reply(401))).toEqual({ ok: false, message: expect.stringMatching(/refused/i) });
		expect(await checkReleaseAccess("ghp_x", reply(404))).toEqual({ ok: false, message: expect.stringMatching(/TeezAI/) });
	});

	test("a network failure is reported, not thrown", async () => {
		const result = await checkReleaseAccess("ghp_x", async () => {
			throw new Error("getaddrinfo ENOTFOUND api.github.com");
		});
		expect(result).toEqual({ ok: false, message: expect.stringMatching(/ENOTFOUND/) });
	});
});
