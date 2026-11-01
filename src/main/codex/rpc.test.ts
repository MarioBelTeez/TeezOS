import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import type { ChildLike } from "../agy/session.ts";
import { CodexRpc, MAX_LINE_BYTES, type RpcHandlers } from "./rpc.ts";

class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = 4242;
	readonly written: unknown[] = [];
	kill = vi.fn();
	constructor() {
		super();
		let buffer = "";
		this.stdin.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let i;
			while ((i = buffer.indexOf("\n")) >= 0) {
				this.written.push(JSON.parse(buffer.slice(0, i)));
				buffer = buffer.slice(i + 1);
			}
		});
	}
	send(message: unknown): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}
}

function setup(overrides: Partial<RpcHandlers> = {}) {
	const child = new FakeChild();
	const notifications: [string, unknown][] = [];
	const log = vi.fn();
	const handlers: RpcHandlers = {
		onNotification: (method, params) => notifications.push([method, params]),
		onServerRequest: async () => ({ decision: "decline" }),
		onExit: vi.fn(),
		...overrides,
	};
	const rpc = new CodexRpc(child as unknown as ChildLike, handlers, log);
	return { child, rpc, notifications, log, handlers };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CodexRpc", () => {
	test("a request writes one JSON line with a new id and resolves with its result", async () => {
		const { child, rpc } = setup();
		const pending = rpc.request("model/list", {});
		await tick();
		expect(child.written).toEqual([{ id: 1, method: "model/list", params: {} }]);
		child.send({ id: 1, result: { data: [] } });
		await expect(pending).resolves.toEqual({ data: [] });
	});

	test("an error response rejects with its message", async () => {
		const { child, rpc } = setup();
		const pending = rpc.request("thread/start", {});
		child.send({ id: 1, error: { code: -32600, message: "bad params" } });
		await expect(pending).rejects.toThrow("bad params");
	});

	test("responses out of order resolve the right requests", async () => {
		const { child, rpc } = setup();
		const a = rpc.request("a", {});
		const b = rpc.request("b", {});
		child.send({ id: 2, result: "B" });
		child.send({ id: 1, result: "A" });
		await expect(a).resolves.toBe("A");
		await expect(b).resolves.toBe("B");
	});

	test("a server request is answered with the handler's result under the same id", async () => {
		const onServerRequest = vi.fn(async () => ({ decision: "accept" }));
		const { child } = setup({ onServerRequest });
		child.send({ id: 0, method: "item/commandExecution/requestApproval", params: { itemId: "x" } });
		await tick();
		await tick();
		expect(onServerRequest).toHaveBeenCalledWith("item/commandExecution/requestApproval", { itemId: "x" }, 0);
		expect(child.written).toContainEqual({ id: 0, result: { decision: "accept" } });
	});

	test("a notification goes to onNotification", async () => {
		const { child, notifications } = setup();
		child.send({ method: "item/agentMessage/delta", params: { delta: "hi" } });
		await tick();
		expect(notifications).toEqual([["item/agentMessage/delta", { delta: "hi" }]]);
	});

	test("a line that is not JSON, and one over the size limit, are dropped and logged; the next line still works", async () => {
		const { child, notifications, log } = setup();
		child.stdout.write("this is not json\n");
		child.stdout.write(`${"x".repeat(MAX_LINE_BYTES + 1)}\n`);
		child.send({ method: "turn/started", params: {} });
		await tick();
		expect(log).toHaveBeenCalledTimes(2);
		expect(notifications).toEqual([["turn/started", {}]]);
	});

	test("a line split across two chunks is reassembled", async () => {
		const { child, notifications } = setup();
		const line = JSON.stringify({ method: "turn/completed", params: { ok: true } });
		child.stdout.write(line.slice(0, 10));
		child.stdout.write(`${line.slice(10)}\n`);
		await tick();
		expect(notifications).toEqual([["turn/completed", { ok: true }]]);
	});

	test("the process exiting rejects pending requests and reports the last stderr", async () => {
		const { child, rpc, handlers } = setup();
		const pending = rpc.request("turn/start", {});
		child.stderr.write("boom: logged out\n");
		await tick();
		child.emit("exit", 1);
		await expect(pending).rejects.toThrow(/exited/);
		expect(handlers.onExit).toHaveBeenCalledWith(1, expect.stringContaining("boom: logged out"));
	});

	test("a request with no answer rejects after its timeout", async () => {
		const { rpc } = setup();
		await expect(rpc.request("account/read", {}, 20)).rejects.toThrow(/timed out/);
	});

	test("notify writes a message without an id", async () => {
		const { child, rpc } = setup();
		rpc.notify("initialized", {});
		await tick();
		expect(child.written).toEqual([{ method: "initialized", params: {} }]);
	});
});
