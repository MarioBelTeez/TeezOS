import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import path from "node:path";
import type { PeerCertificate } from "node:tls";
import { normalizeFingerprint } from "../../../src/main/proxmox/client.ts";
import type { Job, Run, RunEvent } from "../../../runner/src/types.ts";

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_RUNNER_CERT = "/etc/teez-phone/runner.crt";

export class RunnerError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export type RunnerClientDeps = {
	readonly url: string;
	readonly token: string;
	/** PEM of the runner certificate: trusted as the only CA and pinned by fingerprint. */
	readonly ca?: string;
	readonly fetch?: typeof fetch;
};

/** A fetch that trusts exactly the runner certificate (its name will not match 127.0.0.1, so it is pinned instead). */
function pinnedFetch(ca: string): typeof fetch {
	const pinned = normalizeFingerprint(new X509Certificate(ca).fingerprint256);
	const agent = new Agent({
		ca,
		keepAlive: true,
		checkServerIdentity: (_host: string, cert: PeerCertificate) =>
			normalizeFingerprint(cert.fingerprint256) === pinned ? undefined : new Error("The runner certificate changed."),
	});
	return (input, init) =>
		new Promise<Response>((resolve, reject) => {
			const headers = Object.fromEntries(new Headers(init?.headers).entries());
			const payload = typeof init?.body === "string" ? init.body : null;
			const req = httpsRequest(
				new URL(String(input)),
				{ method: init?.method ?? "GET", agent, timeout: REQUEST_TIMEOUT_MS, headers: payload ? { ...headers, "content-length": Buffer.byteLength(payload) } : headers },
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
					res.on("error", reject);
				},
			);
			req.on("timeout", () => req.destroy(new Error("The runner did not answer in time.")));
			req.on("error", reject);
			req.end(payload ?? undefined);
		});
}

/** The phone service side of teez-runner, with the narrow phone token. */
export class RunnerClient {
	readonly #base: string;
	readonly #token: string;
	readonly #fetch: typeof fetch;

	constructor(deps: RunnerClientDeps) {
		this.#base = deps.url;
		this.#token = deps.token;
		if (!deps.fetch && !deps.ca) throw new Error("A runner certificate is required.");
		this.#fetch = deps.fetch ?? pinnedFetch(deps.ca as string);
	}

	async #call<T>(method: "GET" | "POST", pathAndQuery: string): Promise<T> {
		const res = await this.#fetch(new URL(pathAndQuery, this.#base).toString(), {
			method,
			headers: { authorization: `Bearer ${this.#token}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
			...(method === "POST" ? { body: "{}" } : {}),
		});
		const text = await res.text();
		let parsed: unknown = null;
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			// not JSON: report the status
		}
		if (res.ok) return parsed as T;
		const message = parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : `HTTP ${res.status}`;
		throw new RunnerError(message, res.status);
	}

	jobs(): Promise<Job[]> {
		return this.#call("GET", "/jobs");
	}

	runs(limit: number): Promise<Run[]> {
		return this.#call("GET", `/runs?limit=${encodeURIComponent(String(limit))}`);
	}

	run(id: string): Promise<Run> {
		return this.#call("GET", `/runs/${encodeURIComponent(id)}`);
	}

	events(id: string, after: number): Promise<RunEvent[]> {
		return this.#call("GET", `/runs/${encodeURIComponent(id)}/events?after=${encodeURIComponent(String(after))}`);
	}

	runNow(jobId: string): Promise<Run> {
		return this.#call("POST", `/jobs/${encodeURIComponent(jobId)}/run`);
	}

	async cancel(runId: string): Promise<void> {
		await this.#call("POST", `/runs/${encodeURIComponent(runId)}/cancel`);
	}
}

/** The client from `<secretsDir>/runner-token` and the runner certificate; null when either is missing. */
export function loadRunnerClient(secretsDir: string, url: string, certPath: string = DEFAULT_RUNNER_CERT): RunnerClient | null {
	try {
		const token = readFileSync(path.join(secretsDir, "runner-token"), "utf8").trim();
		const ca = readFileSync(certPath, "utf8");
		return token ? new RunnerClient({ url, token, ca }) : null;
	} catch {
		return null;
	}
}
