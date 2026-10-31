import { describe, expect, test, vi } from "vitest";
import type { UiEvent } from "../claude/events.ts";
import { runAgyBtw } from "./btw.ts";

function fakeSession() {
	let emit: (event: UiEvent) => void = () => undefined;
	const session = { send: vi.fn(), dispose: vi.fn() };
	const create = (onEvent: (event: UiEvent) => void) => {
		emit = onEvent;
		return session;
	};
	return { session, create, emit: (event: UiEvent) => emit(event) };
}

describe("runAgyBtw", () => {
	test("sends the question, streams text as deltas and ends with the whole answer", () => {
		const fake = fakeSession();
		const deltas: string[] = [];
		const onDone = vi.fn();
		runAgyBtw({ createSession: fake.create, question: "why?", onDelta: (t) => deltas.push(t), onDone, onError: vi.fn() });
		expect(fake.session.send).toHaveBeenCalledWith("why?");
		fake.emit({ kind: "text-delta", sessionId: "a", text: "Be" });
		fake.emit({ kind: "text-delta", sessionId: "a", text: "cause." });
		fake.emit({ kind: "turn-end", sessionId: "a", ok: true, text: "", durationMs: 1, numTurns: 1, costUsd: 0, context: null });
		expect(deltas).toEqual(["Be", "cause."]);
		expect(onDone).toHaveBeenCalledWith("Because.");
		expect(fake.session.dispose).toHaveBeenCalledTimes(1);
	});

	test("an error ends it and disposes the run", () => {
		const fake = fakeSession();
		const onError = vi.fn();
		runAgyBtw({ createSession: fake.create, question: "q", onDelta: vi.fn(), onDone: vi.fn(), onError });
		fake.emit({ kind: "run-error", sessionId: "", reason: "agy-exit", message: "quota" });
		expect(onError).toHaveBeenCalledWith("quota");
		expect(fake.session.dispose).toHaveBeenCalledTimes(1);
	});

	test("cancel disposes it and silences what follows", () => {
		const fake = fakeSession();
		const onDone = vi.fn();
		const onError = vi.fn();
		const run = runAgyBtw({ createSession: fake.create, question: "q", onDelta: vi.fn(), onDone, onError });
		run.cancel();
		fake.emit({ kind: "turn-cancelled", sessionId: "", durationMs: 1 });
		expect(fake.session.dispose).toHaveBeenCalledTimes(1);
		expect(onDone).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});
});
