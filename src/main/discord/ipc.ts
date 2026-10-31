import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Discord's local RPC: the desktop client listens on a named pipe (a Unix
 * socket on Linux). Each message is an 8-byte header (opcode, body length,
 * both little-endian int32) and a JSON body. Nothing here touches the
 * network, and no OAuth is involved — setting an activity only needs the
 * application id.
 */

export const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 } as const;
export type Frame = { readonly op: number; readonly data: unknown };

/** Discord's own messages are a few KB; anything this big is not Discord. */
const MAX_FRAME = 1024 * 1024;
const HEADER = 8;

export function encodeFrame(op: number, payload: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	const header = Buffer.alloc(HEADER);
	header.writeInt32LE(op, 0);
	header.writeInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}

/** Reassembles frames from however the pipe chooses to chunk them. */
export class FrameDecoder {
	#buffer = Buffer.alloc(0);

	push(chunk: Buffer): Frame[] {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		const frames: Frame[] = [];
		while (this.#buffer.length >= HEADER) {
			const op = this.#buffer.readInt32LE(0);
			const length = this.#buffer.readInt32LE(4);
			if (length < 0 || length > MAX_FRAME) throw new Error(`Discord frame too large (${length} bytes)`);
			if (this.#buffer.length < HEADER + length) break;
			const body = this.#buffer.subarray(HEADER, HEADER + length).toString("utf8");
			this.#buffer = this.#buffer.subarray(HEADER + length);
			let data: unknown = null;
			try {
				data = JSON.parse(body);
			} catch {
				// Leave it null; the caller ignores frames it cannot read.
			}
			frames.push({ op, data });
		}
		return frames;
	}
}

/** Discord takes the first free slot of ten, so a second client (PTB, Canary) moves up one. */
export function pipeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
	const slots = Array.from({ length: 10 }, (_, i) => `discord-ipc-${i}`);
	if (platform === "win32") return slots.map((s) => `\\\\?\\pipe\\${s}`);
	const dirs = [env["XDG_RUNTIME_DIR"], env["TMPDIR"], env["TMP"], env["TEMP"], "/tmp"].filter(
		(d): d is string => typeof d === "string" && d !== "",
	);
	return [...new Set(dirs.flatMap((dir) => slots.map((s) => path.posix.join(dir, s))))];
}

const isBag = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** How long to wait for Discord's READY before giving up on a pipe. */
const READY_TIMEOUT_MS = 5000;

/**
 * One connection to the Discord client. `connect` resolves once Discord has
 * said READY; `onClose` fires once, however the connection ends.
 */
export class DiscordIpc {
	#socket: Socket | null = null;
	#closed = false;
	/** close() was called: stop scanning pipes, even mid-connect. */
	#abandoned = false;
	#onClose: () => void = () => {};

	constructor(
		readonly clientId: string,
		readonly pipes: readonly string[],
	) {}

	onClose(listener: () => void): void {
		this.#onClose = listener;
	}

	async connect(): Promise<void> {
		for (const pipe of this.pipes) {
			if (this.#abandoned) break;
			try {
				await this.#tryPipe(pipe);
				return;
			} catch {
				// Not this slot; try the next.
			}
		}
		throw new Error("Discord is not running.");
	}

	setActivity(activity: unknown): void {
		this.#send(OP.FRAME, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity }, nonce: randomUUID() });
	}

	close(): void {
		this.#abandoned = true;
		if (!this.#socket) return;
		try {
			this.#socket.end(encodeFrame(OP.CLOSE, {}));
		} catch {
			this.#socket.destroy();
		}
	}

	#send(op: number, payload: unknown): void {
		const socket = this.#socket;
		if (socket && !socket.destroyed && !socket.writableEnded) socket.write(encodeFrame(op, payload));
	}

	#tryPipe(pipe: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = connect(pipe);
			const decoder = new FrameDecoder();
			let ready = false;
			const timer = setTimeout(() => fail(new Error("Discord did not answer.")), READY_TIMEOUT_MS);

			const fail = (error: Error): void => {
				clearTimeout(timer);
				socket.destroy();
				if (!ready) reject(error);
			};

			socket.once("connect", () => socket.write(encodeFrame(OP.HANDSHAKE, { v: 1, client_id: this.clientId })));
			socket.on("data", (chunk: Buffer) => {
				let frames: Frame[];
				try {
					frames = decoder.push(chunk);
				} catch (error) {
					fail(error as Error);
					return;
				}
				for (const frame of frames) {
					if (frame.op === OP.PING) socket.write(encodeFrame(OP.PONG, frame.data));
					else if (frame.op === OP.CLOSE) fail(new Error("Discord closed the connection."));
					else if (!ready && frame.op === OP.FRAME && isBag(frame.data) && frame.data["evt"] === "READY") {
						ready = true;
						clearTimeout(timer);
						this.#socket = socket;
						resolve();
					}
				}
			});
			socket.on("error", (error) => fail(error));
			socket.on("close", () => {
				clearTimeout(timer);
				if (!ready) {
					reject(new Error("Discord closed the pipe."));
					return;
				}
				if (this.#socket === socket) this.#socket = null;
				if (!this.#closed) {
					this.#closed = true;
					this.#onClose();
				}
			});
		});
	}
}
