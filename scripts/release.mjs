/**
 * Build and publish a release to GitHub.
 *
 * electron-builder uploads the installer and its blockmap in parallel, and each
 * upload creates the GitHub release when it is missing. The second one gets
 * "422 Published releases must have a valid tag" and the build aborts with the
 * installer half sent — seen on 0.2.0, 0.2.1 and 0.2.2. Creating the release
 * first (with `gh`) leaves nothing to race over; electron-builder then only
 * uploads into it.
 *
 * The release is created as a **draft** and published only once latest.yml and
 * the installer are in it. Published first, it was "Latest" with no latest.yml
 * for about a minute (0.3.6), and an app checking then got "Cannot find
 * latest.yml in the release". (package.json's publish.releaseType is "draft"
 * so electron-builder uploads into the draft instead of skipping it.)
 *
 * Needs `gh` logged in, and GH_TOKEN for electron-builder:
 *   GH_TOKEN=$(gh auth token) npm run release
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const { version } = pkg;
// The installer is named after the product (TeezAI until 0.3.7, TeezOS since).
const productName = pkg.build.productName;
// The repo keeps its old name: every installed copy looks for updates there.
const repo = "MarioBelTeez/TeezAI";
const tag = `v${version}`;
// The branch the release tag is cut from; main unless a release ships from its feature branch first.
const target = process.env["RELEASE_TARGET"] || "main";

if (!process.env["GH_TOKEN"]) {
	console.error("GH_TOKEN is not set. Run: GH_TOKEN=$(gh auth token) npm run release");
	process.exit(1);
}

// gh is an executable; npx is a .cmd on Windows and needs the shell (whose
// unquoted arguments split on spaces, so only plain words go through it).
const run = (command, args, shell = false) => execFileSync(command, args, { stdio: "inherit", shell });

let exists = true;
try {
	execFileSync("gh", ["release", "view", tag, "-R", repo], { stdio: "ignore" });
} catch {
	exists = false;
}
if (!exists) run("gh", ["release", "create", tag, "-R", repo, "--draft", "--target", target, "--title", version, "--notes", `${productName} ${version}`]);

run("npx", ["electron-builder", "--win", "--publish", "always"], process.platform === "win32");

// Publish only a complete release.
const installer = `${productName}-Setup-${version}.exe`;
const assets = JSON.parse(execFileSync("gh", ["release", "view", tag, "-R", repo, "--json", "assets"], { encoding: "utf8" })).assets;
const uploaded = (name) => assets.some((asset) => asset.name === name && asset.state === "uploaded" && asset.size > 0);
const missing = ["latest.yml", installer, `${installer}.blockmap`].filter((name) => !uploaded(name));
if (missing.length > 0) {
	console.error(`Not publishing ${tag}: missing ${missing.join(", ")}. The draft is still there; fix and re-run.`);
	process.exit(1);
}
run("gh", ["release", "edit", tag, "-R", repo, "--draft=false", "--latest"]);
console.log(`Published ${tag}.`);
