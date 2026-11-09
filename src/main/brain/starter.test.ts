import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	BUNDLED_AGENT_IDS,
	BUNDLED_COMMAND_IDS,
	BUNDLED_SKILL_IDS,
	createStarterBrain,
	personalizeStarterBrain,
} from "./starter.ts";
import { scanVault } from "./vault.ts";

describe("createStarterBrain", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "teez-starter-brain-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("generates starter brain structure and only brain/QoL skills & commands", async () => {
		const target = path.join(dir, "TeezMind");
		const res = createStarterBrain({
			targetDir: target,
			today: "2026-11-09",
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		expect(existsSync(path.join(target, "Home.md"))).toBe(true);
		expect(existsSync(path.join(target, "CLAUDE.md"))).toBe(true);
		expect(existsSync(path.join(target, "GEMINI.md"))).toBe(true);
		expect(existsSync(path.join(target, "vault-manifest.json"))).toBe(true);
		expect(existsSync(path.join(target, "brain/Memories.md"))).toBe(true);
		expect(existsSync(path.join(target, "brain/North Star.md"))).toBe(true);
		expect(existsSync(path.join(target, "brain/Skills.md"))).toBe(true);
		expect(existsSync(path.join(target, "work/Index.md"))).toBe(true);
		expect(existsSync(path.join(target, "work/active/Getting Started with TeezOS.md"))).toBe(true);
		expect(existsSync(path.join(target, "reference/sources/.gitkeep"))).toBe(true);
		expect(existsSync(path.join(target, "brain/concepts/.gitkeep"))).toBe(true);
		expect(existsSync(path.join(target, "thinking/skill-drafts/.gitkeep"))).toBe(true);

		const skills = readdirSync(path.join(target, ".claude/skills")).sort();
		expect(skills).toEqual([...BUNDLED_SKILL_IDS].sort());
		expect(skills).not.toContain("ui-ux-pro-max");

		const commands = readdirSync(path.join(target, ".claude/commands"))
			.map((f) => f.replace(/\.md$/, ""))
			.sort();
		expect(commands).toEqual([...BUNDLED_COMMAND_IDS].sort());
		expect(commands).not.toContain("om-peer-scan");
		expect(commands).not.toContain("om-review-brief");
		expect(commands).not.toContain("om-self-review");
		expect(commands).not.toContain("om-review-peer");
		expect(commands).not.toContain("om-phone-inbox");

		const agents = readdirSync(path.join(target, ".claude/agents"))
			.map((f) => f.replace(/\.md$/, ""))
			.sort();
		expect(agents).toEqual([...BUNDLED_AGENT_IDS].sort());

		// Verify the Brain graph indexes cleanly withconnected notes
		const index = await scanVault(target);
		expect(index.notes.length).toBeGreaterThanOrEqual(8);
		expect(index.edges.length).toBeGreaterThan(0);
	});

	test("pre-fills Memories.md and North Star.md when optional name and goals are provided", () => {
		const target = path.join(dir, "TeezMind");
		createStarterBrain({ targetDir: target, today: "2026-11-09" });

		const pRes = personalizeStarterBrain(target, {
			userName: "Alex",
			goals: ["Launch my indie SaaS by Q1", "Build a research vault for uni"],
			useCases: ["Coding & Software", "Second Brain & Notes"],
			today: "2026-11-09",
		});
		expect(pRes.ok).toBe(true);

		const memories = readFileSync(path.join(target, "brain/Memories.md"), "utf-8");
		expect(memories).toContain("- **Name:** Alex");
		expect(memories).toContain("Coding & Software, Second Brain & Notes");

		const northStar = readFileSync(path.join(target, "brain/North Star.md"), "utf-8");
		expect(northStar).toContain("# Alex's North Star");
		expect(northStar).toContain("1. **Launch my indie SaaS by Q1**");
		expect(northStar).toContain("2. **Build a research vault for uni**");
	});

	test("preserves existing custom notes in an existing folder", () => {
		const target = path.join(dir, "ExistingVault");
		createStarterBrain({ targetDir: target, today: "2026-11-09" });
		writeFileSync(path.join(target, "Home.md"), "# My Custom Home\n", "utf-8");
		writeFileSync(path.join(target, "brain/Memories.md"), "# My Custom Memories\n", "utf-8");

		createStarterBrain({ targetDir: target, today: "2026-11-09" });
		expect(readFileSync(path.join(target, "Home.md"), "utf-8")).toBe("# My Custom Home\n");

		personalizeStarterBrain(target, { userName: "NewName", goals: ["Goal 1"] });
		expect(readFileSync(path.join(target, "brain/Memories.md"), "utf-8")).toBe("# My Custom Memories\n");
	});

	test("rejects relative paths and network shares", () => {
		expect(createStarterBrain({ targetDir: "relative/path" }).ok).toBe(false);
		expect(createStarterBrain({ targetDir: "\\\\server\\share\\vault" }).ok).toBe(false);
	});
});
