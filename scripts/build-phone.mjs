// Builds the phone companion into phone/dist, ready for phone/deploy/provision.sh:
//   server.mjs     the service, one esbuild bundle (web-push stays external)
//   package.json   web-push pinned to the version this repo tests with (a devDependency
//                  of the repo, so the desktop installer never ships it)
//   package-lock.json  the server install resolved once, for `npm ci` in the container
//   app/           the PWA (Vite)
//   watch/         the /watch plugin's scripts (watch.py and its modules), when found on this PC
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { locateWatchScript } from "../src/main/feed/source.ts";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "phone", "dist");
mkdirSync(dist, { recursive: true });

console.log("phone: bundling the server");
await esbuild({
	entryPoints: [join(root, "phone", "server", "src", "main.ts")],
	outfile: join(dist, "server.mjs"),
	bundle: true,
	platform: "node",
	target: "node24",
	format: "esm",
	external: ["web-push"],
	logLevel: "warning",
});

const webPush = JSON.parse(readFileSync(join(root, "node_modules", "web-push", "package.json"), "utf8")).version;
const manifest = { name: "teez-phone", private: true, type: "module", dependencies: { "web-push": webPush } };
writeFileSync(join(dist, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
// A lockfile for the server install: ct-install.sh runs `npm ci`, so every deploy gets these exact versions.
console.log("phone: locking the server dependencies");
rmSync(join(dist, "package-lock.json"), { force: true });
rmSync(join(dist, "node_modules"), { recursive: true, force: true });
const npmArgs = ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
// npm is npm.cmd on Windows, which only runs through a shell.
if (process.platform === "win32") execFileSync(`npm ${npmArgs.join(" ")}`, { cwd: dist, stdio: "inherit", shell: true });
else execFileSync("npm", npmArgs, { cwd: dist, stdio: "inherit" });

console.log("phone: building the app");
await viteBuild({ configFile: join(root, "phone", "app", "vite.config.ts"), logLevel: "warn" });

// watch.py imports its sibling modules (download, frames, transcribe, whisper): copy the whole set.
const watchDir = join(dist, "watch");
rmSync(watchDir, { recursive: true, force: true });
const script = locateWatchScript(homedir());
if (script) {
	mkdirSync(watchDir, { recursive: true });
	const from = dirname(script);
	for (const name of readdirSync(from).filter((file) => file.endsWith(".py"))) cpSync(join(from, name), join(watchDir, name));
	console.log(`phone: watch scripts from ${from}`);
} else {
	console.warn("phone: WARNING no /watch plugin found in ~/.claude/plugins/cache; video sources will not work on the server");
}

for (const file of ["server.mjs", "package.json", "package-lock.json", join("app", "index.html")]) {
	if (!existsSync(join(dist, file))) throw new Error(`phone: ${file} was not built`);
}
console.log(`phone: built ${dist}`);
