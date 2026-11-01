import path from "node:path";
import { defaultKillTree, defaultSpawn, type ChildLike, type SpawnFn } from "../agy/session.ts";
import type { AgentSession, SlashCommandInfo } from "../agents/registry.ts";
import type { UiEvent } from "../claude/events.ts";
import type { ApprovalDecision, ApprovalRequest } from "../claude/service.ts";
import type { ChatImage } from "../../shared/images.ts";
import { CodexEventConverter, fileChangeInput } from "./events.ts";
import { CodexRpc } from "./rpc.ts";

/**
 * One Codex chat: a `codex app-server` process (started on the first message)
 * holding one thread. Approvals come in as server requests and become the
 * chat's Approve / Deny cards. On Windows the approval policy is the real
 * boundary (Codex's sandbox isn't set up there), so outside Full access every
 * command and edit asks; Auto-edit is TeezOS accepting edits whose every path
 * is inside the workspace. See docs/superpowers/notes/2026-10-31-codex-protocol.md.
 */

export type CodexSessionDeps = {
	readonly codexPath: string;
	readonly cwd: string;
	/** "" = Codex's default for the account. */
	readonly model: string;
	readonly permission: string;
	readonly effort: string;
	/** A thread to continue (Codex's thread id). */
	readonly resume?: string;
	readonly onEvent: (event: UiEvent) => void;
	readonly onApproval: (request: ApprovalRequest) => void;
	readonly spawn?: SpawnFn;
	readonly killTree?: (child: ChildLike) => void;
	/** Reported to Codex as the client's version. */
	readonly clientVersion?: string;
	readonly log?: (line: string) => void;
};

type Policy = { readonly approvalPolicy: "untrusted" | "never"; readonly sandbox: "workspace-write" | "danger-full-access" };

export function codexPolicy(permission: string): Policy {
	return permission === "full-access"
		? { approvalPolicy: "never", sandbox: "danger-full-access" }
		: { approvalPolicy: "untrusted", sandbox: "workspace-write" };
}

type Decision = { readonly decision: "accept" | "decline" };
const DECLINE: Decision = { decision: "decline" };
const ACCEPT: Decision = { decision: "accept" };

function isBag(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `file` is the folder or inside it (case-insensitive on Windows). Unclear means no. */
export function isInside(folder: string, file: string, platform: NodeJS.Platform = process.platform): boolean {
	const api = platform === "win32" ? path.win32 : path.posix;
	if (!file || !api.isAbsolute(file)) return false;
	const norm = (p: string) => (platform === "win32" ? api.resolve(p).toLowerCase() : api.resolve(p));
	const relative = api.relative(norm(folder), norm(file));
	return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
}

export class CodexSession implements AgentSession {
	readonly #deps: CodexSessionDeps;
	readonly #converter: CodexEventConverter;
	#model: string;
	#permission: string;
	#effort: string;
	#threadId = "";
	#turnId = "";
	#child: ChildLike | null = null;
	#rpc: CodexRpc | null = null;
	#starting: Promise<boolean> | null = null;
	#running = false;
	#stopping = false;
	#disposed = false;
	readonly #queue: string[] = [];
	/** Each file change's paths, from its item/started, by item id: the approval request names only the item. */
	readonly #changes = new Map<string, unknown>();
	readonly #approvals = new Map<string, (decision: Decision) => void>();
	#approvalSeq = 0;

	constructor(deps: CodexSessionDeps) {
		this.#deps = deps;
		this.#model = deps.model;
		this.#permission = deps.permission;
		this.#effort = deps.effort;
		this.#threadId = deps.resume ?? "";
		this.#converter = new CodexEventConverter(() => this.#threadId);
	}

	get sessionId(): string {
		return this.#threadId;
	}

	send(text: string, images: readonly ChatImage[] = []): void {
		if (this.#disposed) return;
		const message = images.length > 0 ? `${text}\n\n[${images.length} pasted image(s) left out: TeezOS sends Codex text only for now]` : text;
		this.#stopping = false;
		this.#queue.push(message);
		void this.#pump();
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		this.#queue.length = 0;
		this.#declineAll();
		if (this.#rpc && this.#running && this.#threadId && this.#turnId) {
			await this.#rpc.request("turn/interrupt", { threadId: this.#threadId, turnId: this.#turnId }, 15_000).catch(() => undefined);
		}
	}

	respondToApproval(id: string, decision: ApprovalDecision): void {
		const resolve = this.#approvals.get(id);
		if (!resolve) return;
		this.#approvals.delete(id);
		resolve(decision === "allow" ? ACCEPT : DECLINE);
	}

	async setModel(model: string): Promise<void> {
		this.#model = model;
	}

	async setPermissionMode(mode: string): Promise<void> {
		this.#permission = mode;
	}

	async setEffort(effort: string): Promise<void> {
		this.#effort = effort;
	}

	async commands(): Promise<SlashCommandInfo[]> {
		return [];
	}

	dispose(): void {
		this.#disposed = true;
		this.#queue.length = 0;
		this.#declineAll();
		const child = this.#child;
		this.#rpc?.close();
		this.#rpc = null;
		this.#child = null;
		if (child) (this.#deps.killTree ?? defaultKillTree)(child);
	}

	/** Sends the next queued message once no turn is running. */
	async #pump(): Promise<void> {
		if (this.#running || this.#queue.length === 0 || this.#disposed) return;
		this.#running = true;
		const ready = await this.#ensureStarted();
		const text = this.#queue.shift();
		if (!ready || text === undefined || !this.#rpc) {
			this.#running = false;
			return;
		}
		const policy = codexPolicy(this.#permission);
		try {
			const result = await this.#rpc.request<{ turn?: { id?: string } }>("turn/start", {
				threadId: this.#threadId,
				input: [{ type: "text", text, text_elements: [] }],
				...(this.#model ? { model: this.#model } : {}),
				effort: this.#effort,
				approvalPolicy: policy.approvalPolicy,
				sandboxPolicy:
					policy.sandbox === "danger-full-access"
						? { type: "dangerFullAccess" }
						: { type: "workspaceWrite", writableRoots: [this.#deps.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
			});
			this.#turnId = result?.turn?.id ?? "";
			// Stop was pressed while the turn was starting: interrupt it now that it has an id.
			if (this.#stopping && this.#turnId && this.#rpc) {
				await this.#rpc.request("turn/interrupt", { threadId: this.#threadId, turnId: this.#turnId }, 15_000).catch(() => undefined);
			}
		} catch (error) {
			this.#running = false;
			this.#emit({ kind: "run-error", sessionId: this.#threadId, reason: "codex-turn-start", message: error instanceof Error ? error.message : String(error) });
		}
	}

	#ensureStarted(): Promise<boolean> {
		if (this.#rpc) return Promise.resolve(true);
		this.#starting ??= this.#start().finally(() => {
			this.#starting = null;
		});
		return this.#starting;
	}

	async #start(): Promise<boolean> {
		const child = (this.#deps.spawn ?? defaultSpawn)(this.#deps.codexPath, ["app-server"], { cwd: this.#deps.cwd });
		this.#child = child;
		const rpc = new CodexRpc(
			child,
			{
				onNotification: (method, params) => this.#onNotification(method, params),
				onServerRequest: (method, params) => this.#onServerRequest(method, params),
				onExit: (code, stderr) => this.#onExit(child, code, stderr),
			},
			this.#deps.log,
		);
		this.#rpc = rpc;
		try {
			await rpc.request("initialize", { clientInfo: { name: "teezos", title: "TeezOS", version: this.#deps.clientVersion ?? "0" }, capabilities: null });
			rpc.notify("initialized", {});
			const policy = codexPolicy(this.#permission);
			const thread = this.#threadId
				? await rpc.request<{ thread?: { id?: string } }>("thread/resume", { threadId: this.#threadId, cwd: this.#deps.cwd, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox })
				: await rpc.request<{ thread?: { id?: string } }>("thread/start", {
						cwd: this.#deps.cwd,
						...(this.#model ? { model: this.#model } : {}),
						approvalPolicy: policy.approvalPolicy,
						sandbox: policy.sandbox,
					});
			this.#threadId = thread?.thread?.id ?? this.#threadId;
			this.#emit({ kind: "session-ready", sessionId: this.#threadId, model: this.#model, permissionMode: this.#permission, toolCount: 0, cwd: this.#deps.cwd, slashCommands: [] });
			return true;
		} catch (error) {
			this.#emit({ kind: "run-error", sessionId: this.#threadId, reason: "codex-start", message: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}

	#onNotification(method: string, params: unknown): void {
		if (this.#disposed) return;
		if (method === "item/started" && isBag(params) && isBag(params["item"]) && params["item"]["type"] === "fileChange") {
			this.#changes.set(String(params["item"]["id"]), params["item"]["changes"]);
		}
		for (const event of this.#converter.convert(method, params)) this.#emit(event);
		if (method === "turn/completed") this.#turnEnded();
	}

	#turnEnded(): void {
		this.#running = false;
		this.#turnId = "";
		this.#changes.clear();
		void this.#pump();
	}

	async #onServerRequest(method: string, params: unknown): Promise<unknown> {
		// After Stop or close nothing new runs: answer at once, never show a card.
		if (this.#disposed || this.#stopping || !isBag(params)) return DECLINE;
		if (method === "item/commandExecution/requestApproval") {
			return this.#ask("Bash", { command: String(params["command"] ?? ""), cwd: String(params["cwd"] ?? "") });
		}
		if (method === "item/fileChange/requestApproval") {
			const changes = this.#changes.get(String(params["itemId"] ?? ""));
			if (this.#permission === "auto-edit" && this.#allInside(changes)) return ACCEPT;
			return this.#ask("Edit", fileChangeInput(changes) ?? { item: String(params["itemId"] ?? "") });
		}
		// Anything else that asks for permission (or input) is refused: TeezOS has no card for it.
		return DECLINE;
	}

	#allInside(changes: unknown): boolean {
		if (!Array.isArray(changes) || changes.length === 0) return false;
		return changes.every((change) => isBag(change) && typeof change["path"] === "string" && isInside(this.#deps.cwd, change["path"]));
	}

	#ask(toolName: string, input: Record<string, unknown>): Promise<Decision> {
		const id = `codex-${(this.#approvalSeq += 1)}`;
		return new Promise<Decision>((resolve) => {
			this.#approvals.set(id, resolve);
			this.#deps.onApproval({ id, toolName, input });
		});
	}

	#declineAll(): void {
		for (const [id, resolve] of this.#approvals) {
			this.#approvals.delete(id);
			resolve(DECLINE);
		}
	}

	#onExit(child: ChildLike, code: number | null, stderr: string): void {
		if (this.#child !== child) return;
		this.#child = null;
		this.#rpc = null;
		this.#declineAll();
		const wasRunning = this.#running;
		this.#running = false;
		this.#turnId = "";
		if (this.#disposed) return;
		if (wasRunning || code !== 0) {
			// Codex's stderr is coloured log output; the card wants plain text.
			// eslint-disable-next-line no-control-regex
			const last = stderr.replace(/\u001b\[[0-9;]*m/g, "").trim().split("\n").pop() ?? "";
			this.#emit({ kind: "run-error", sessionId: this.#threadId, reason: "codex-exited", message: `Codex stopped${code !== null ? ` (exit ${code})` : ""}.${last ? ` ${last}` : ""}` });
		}
		void this.#pump();
	}

	#emit(event: UiEvent): void {
		if (!this.#disposed) this.#deps.onEvent(event);
	}
}
