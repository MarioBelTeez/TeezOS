import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The phone app (PWA): built to phone/dist/app, which the phone service
 * serves with `default-src 'self'`. So: no inlined assets (a data: font is
 * refused), and the service worker is its own entry at /sw.js.
 */

const here = import.meta.dirname;
const SW_FILE = "sw.js";

/** The service worker is loaded as a classic script: it must not import a shared chunk. */
function standaloneServiceWorker(): Plugin {
	return {
		name: "teez-standalone-sw",
		generateBundle(_options, bundle) {
			const sw = bundle[SW_FILE];
			if (!sw || sw.type !== "chunk") this.error(`${SW_FILE} was not built`);
			else if (sw.imports.length > 0 || sw.dynamicImports.length > 0) this.error(`${SW_FILE} imports other chunks: ${sw.imports.join(", ")}`);
		},
	};
}

export default defineConfig({
	root: here,
	publicDir: resolve(here, "public"),
	plugins: [react(), tailwindcss(), standaloneServiceWorker()],
	build: {
		outDir: "../dist/app",
		emptyOutDir: true,
		assetsInlineLimit: 0,
		modulePreload: { polyfill: false },
		rollupOptions: {
			input: { index: resolve(here, "index.html"), sw: resolve(here, "src/sw.ts") },
			output: { entryFileNames: (chunk) => (chunk.name === "sw" ? SW_FILE : "assets/[name]-[hash].js") },
		},
	},
});
