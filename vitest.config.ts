import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "runner/src/**/*.test.ts", "phone/server/src/**/*.test.ts", "phone/app/src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/main/**/*.ts", "src/shared/**/*.ts", "runner/src/**/*.ts"],
			exclude: ["**/*.test.ts"],
		},
	},
});
