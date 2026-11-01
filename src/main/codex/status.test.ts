import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { codexModelsOf, codexStatus } from "./status.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), "utf8")) as unknown;

describe("codexStatus", () => {
	test("not installed", async () => {
		const probe = vi.fn();
		await expect(codexStatus({ locate: () => null, version: async () => "0.166.0", probe })).resolves.toEqual({ available: false, reason: "codex-not-found", models: [] });
		expect(probe).not.toHaveBeenCalled();
	});

	test("a version outside the supported range is unsupported, and Codex is not even started", async () => {
		const probe = vi.fn();
		await expect(codexStatus({ locate: () => "C:/codex.exe", version: async () => "0.170.2", probe })).resolves.toMatchObject({
			available: false,
			reason: "codex-unsupported",
			version: "0.170.2",
		});
		expect(probe).not.toHaveBeenCalled();
	});

	test("an unreadable version counts as unsupported", async () => {
		await expect(codexStatus({ locate: () => "C:/codex.exe", version: async () => null, probe: vi.fn() })).resolves.toMatchObject({ reason: "codex-unsupported" });
	});

	test("logged out", async () => {
		await expect(
			codexStatus({ locate: () => "C:/codex.exe", version: async () => "0.166.0", probe: async () => ({ loggedIn: false, models: [] }) }),
		).resolves.toEqual({ available: false, reason: "codex-logged-out", models: [] });
	});

	test("logged in: available, with the account's models", async () => {
		const models = codexModelsOf(fixture("model-list"));
		await expect(codexStatus({ locate: () => "C:/codex.exe", version: async () => "0.166.0", probe: async () => ({ loggedIn: true, models }) })).resolves.toEqual({
			available: true,
			models,
		});
	});
});

describe("codexModelsOf", () => {
	test("visible models by display name, the account's default first", () => {
		const models = codexModelsOf(fixture("model-list"));
		expect(models).toHaveLength(9);
		expect(models[0]).toEqual({ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" });
		expect(models.map((m) => m.id)).toContain("gpt-5.5");
	});

	test("hidden models are left out and junk is ignored", () => {
		expect(codexModelsOf({ data: [{ id: "a", displayName: "A", hidden: true }, { id: "b", displayName: "B" }, 42, { displayName: "no id" }] })).toEqual([{ id: "b", label: "B" }]);
		expect(codexModelsOf(null)).toEqual([]);
	});
});
