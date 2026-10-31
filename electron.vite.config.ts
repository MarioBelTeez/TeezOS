import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = import.meta.dirname;

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: { input: resolve(here, "src/main/index.ts") },
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: resolve(here, "src/preload/index.ts"),
				// A sandboxed preload must be CommonJS. With "type": "module" in
				// package.json electron-vite would emit index.mjs, which Electron
				// refuses ("Cannot use import statement outside a module") — the
				// bridge then never loads and the window renders nothing at all.
				output: { format: "cjs", entryFileNames: "index.cjs" },
			},
		},
	},
	renderer: {
		root: resolve(here, "src/renderer"),
		plugins: [react(), tailwindcss()],
		build: {
			rollupOptions: { input: resolve(here, "src/renderer/index.html") },
		},
	},
});
