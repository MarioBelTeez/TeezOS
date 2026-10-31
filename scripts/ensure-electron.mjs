/**
 * Download the Electron binary after `npm install`.
 *
 * Electron 44 ships **no postinstall script** — its package.json has no
 * `scripts` field at all, only an `install-electron` bin. So a plain
 * `npm install` leaves `node_modules/electron` without `dist/`, and the first
 * `npm run dev` dies inside electron-vite with "Error: Electron uninstall",
 * which names neither the real cause nor the fix. This runs the installer the
 * package ships, so a fresh clone works after one `npm install`.
 *
 * It exits quietly when Electron is not installed at all: production installs
 * omit dev dependencies, and a postinstall that fails there would break them.
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);

let installer;
try {
	installer = require.resolve("electron/install.js");
} catch {
	process.exit(0);
}

// The installer is idempotent: it checks its own cache and the recorded path,
// so re-running it after the binary exists costs a moment, not a download.
execFileSync(process.execPath, [installer], { stdio: "inherit" });
