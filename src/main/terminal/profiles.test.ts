import { describe, expect, test } from "vitest";
import { terminalProgram } from "./service.ts";

describe("terminal profiles", () => {
	test("codex-login opens a shell running `codex login`, and stays open after", () => {
		const program = terminalProgram("codex-login");
		expect(program.args.join(" ")).toContain("codex login");
		expect(program.title).toBe("codex login");
	});
});
