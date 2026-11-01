import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("the chat bar never rewrites the saved defaults (agent, model, mode, effort)", () => {
	const source = readFileSync(new URL("./ComposerBar.tsx", import.meta.url), "utf8");
	expect(source).not.toMatch(/\bsetAgent\(/);
});
