import { describe, expect, it, vi } from "vitest";
import { RunnerClient, RunnerError, loadRunnerClient } from "./runner-client.ts";

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

describe("runner client", () => {
	it("sends the bearer token and the right paths", async () => {
		const fetch = vi.fn().mockImplementation(async () => reply(200, []));
		const client = new RunnerClient({ url: "https://127.0.0.1:7420", token: "tok", fetch });
		await client.runs(50);
		await client.events("r 1", 3);
		await client.runNow("j1");
		const calls = fetch.mock.calls.map(([url, init]) => [url, init.method, init.headers.authorization]);
		expect(calls).toEqual([
			["https://127.0.0.1:7420/runs?limit=50", "GET", "Bearer tok"],
			["https://127.0.0.1:7420/runs/r%201/events?after=3", "GET", "Bearer tok"],
			["https://127.0.0.1:7420/jobs/j1/run", "POST", "Bearer tok"],
		]);
	});

	it("raises the runner's error with its status", async () => {
		const client = new RunnerClient({ url: "https://x", token: "t", fetch: vi.fn().mockResolvedValue(reply(403, { error: "Forbidden." })) });
		await expect(client.jobs()).rejects.toEqual(new RunnerError("Forbidden.", 403));
	});

	it("loads nothing when the token or certificate is missing", () => {
		expect(loadRunnerClient("/nonexistent-dir", "https://x", "/nonexistent.crt")).toBeNull();
	});
});
