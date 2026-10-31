import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The runner ships as .ts and runs under Node's built-in type stripping, with
 * no build step. Stripping refuses TypeScript that needs transforming —
 * parameter properties, enums, namespaces — and the first deploy crash-looped
 * on exactly that. Vitest would not notice (it transpiles), so load each file
 * with plain Node here.
 */
describe("runner sources load under plain Node", () => {
	const dir = import.meta.dirname;
	// main.ts starts the server on import, so it is left out.
	const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "main.ts");

	test.each(files)("%s", (file) => {
		const url = new URL(`file:///${join(dir, file).replace(/\\/g, "/")}`).href;
		const output = execFileSync(process.execPath.includes("node") ? process.execPath : "node", ["-e", `import(${JSON.stringify(url)}).then(() => console.log("ok"))`], {
			encoding: "utf8",
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
		});
		expect(output.trim()).toBe("ok");
	});
});
