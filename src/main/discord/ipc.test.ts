import { describe, expect, test } from "vitest";
import { FrameDecoder, OP, encodeFrame, pipeCandidates } from "./ipc.ts";

describe("encodeFrame", () => {
	test("little-endian opcode and length, then UTF-8 JSON", () => {
		const frame = encodeFrame(OP.HANDSHAKE, { v: 1, client_id: "42" });
		const body = JSON.stringify({ v: 1, client_id: "42" });
		expect(frame.readInt32LE(0)).toBe(0);
		expect(frame.readInt32LE(4)).toBe(Buffer.byteLength(body));
		expect(frame.subarray(8).toString("utf8")).toBe(body);
	});

	test("the length counts bytes, not characters", () => {
		const frame = encodeFrame(OP.FRAME, { s: "é" });
		expect(frame.readInt32LE(4)).toBe(frame.length - 8);
	});
});

describe("FrameDecoder", () => {
	test("frames split across chunks and glued together both come out whole", () => {
		const a = encodeFrame(OP.FRAME, { evt: "READY" });
		const b = encodeFrame(OP.PONG, { n: 2 });
		const all = Buffer.concat([a, b]);
		const decoder = new FrameDecoder();
		const out = [
			...decoder.push(all.subarray(0, 3)),
			...decoder.push(all.subarray(3, a.length + 5)),
			...decoder.push(all.subarray(a.length + 5)),
		];
		expect(out).toEqual([
			{ op: OP.FRAME, data: { evt: "READY" } },
			{ op: OP.PONG, data: { n: 2 } },
		]);
	});

	test("a body that is not JSON is reported as null data, not thrown", () => {
		const header = Buffer.alloc(8);
		header.writeInt32LE(OP.FRAME, 0);
		header.writeInt32LE(3, 4);
		const decoder = new FrameDecoder();
		expect(decoder.push(Buffer.concat([header, Buffer.from("{{{")]))).toEqual([{ op: OP.FRAME, data: null }]);
	});

	test("an absurd length is refused instead of buffered forever", () => {
		const header = Buffer.alloc(8);
		header.writeInt32LE(OP.FRAME, 0);
		header.writeInt32LE(64 * 1024 * 1024, 4);
		const decoder = new FrameDecoder();
		expect(() => decoder.push(header)).toThrow(/too large/);
	});
});

describe("pipeCandidates", () => {
	test("Windows uses the ten named pipes", () => {
		const pipes = pipeCandidates("win32", {});
		expect(pipes).toHaveLength(10);
		expect(pipes[0]).toBe("\\\\?\\pipe\\discord-ipc-0");
		expect(pipes[9]).toBe("\\\\?\\pipe\\discord-ipc-9");
	});

	test("Linux looks in the runtime dir, then the temp dirs, without repeats", () => {
		const pipes = pipeCandidates("linux", { XDG_RUNTIME_DIR: "/run/user/1000", TMPDIR: "/tmp" });
		expect(pipes[0]).toBe("/run/user/1000/discord-ipc-0");
		expect(pipes).toContain("/tmp/discord-ipc-9");
		expect(new Set(pipes).size).toBe(pipes.length);
	});
});
