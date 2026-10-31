import { describe, expect, test } from "vitest";
import { combineDraft } from "./draft.ts";

describe("combineDraft", () => {
	test("append: a mention joins the draft after a space", () => {
		expect(combineDraft("look at", "@a.ts ", "append")).toBe("look at @a.ts ");
		expect(combineDraft("look at ", "@a.ts ", "append")).toBe("look at @a.ts ");
		expect(combineDraft("", "@a.ts ", "append")).toBe("@a.ts ");
	});

	test("prefill into an empty draft: just the hand-over", () => {
		expect(combineDraft("", "Context from the Claude chat «t»:", "prefill")).toBe("Context from the Claude chat «t»:");
		expect(combineDraft("  \n", "Context", "prefill")).toBe("Context");
	});

	test("prefill goes first; what was being typed follows it", () => {
		expect(combineDraft("now refactor x.ts\n", "Context from the Claude chat «t»:\nYou: fix it", "prefill")).toBe(
			"Context from the Claude chat «t»:\nYou: fix it\n\nnow refactor x.ts",
		);
	});
});
