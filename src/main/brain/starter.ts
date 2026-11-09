import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type StarterBrainOptions = {
	readonly targetDir: string;
	readonly userName?: string | undefined;
	readonly goals?: readonly string[] | undefined;
	readonly useCases?: readonly string[] | undefined;
	readonly today?: string | undefined;
};

export type StarterBrainResult =
	| { readonly ok: true; readonly path: string; readonly createdFiles: number }
	| { readonly ok: false; readonly reason: string };

export type PersonalizeOptions = {
	readonly userName?: string | undefined;
	readonly goals?: readonly string[] | undefined;
	readonly useCases?: readonly string[] | undefined;
	readonly today?: string | undefined;
};

/** Bundled brain-oriented & QoL skills included in every Starter Brain (never corporate review or personal work skills). */
export const BUNDLED_SKILL_IDS = [
	"obsidian-markdown",
	"obsidian-bases",
	"obsidian-cli",
	"json-canvas",
	"defuddle",
	"qmd",
] as const;

export const BUNDLED_COMMAND_IDS = [
	"om-standup",
	"om-dump",
	"om-wrap-up",
	"om-weekly",
	"om-vault-audit",
	"om-humanize",
] as const;

export const BUNDLED_AGENT_IDS = [
	"context-loader",
	"cross-linker",
	"vault-librarian",
] as const;

function isUncOrRoot(resolved: string): boolean {
	if (resolved.startsWith("\\\\") || resolved.startsWith("//")) return true;
	const parsed = path.parse(resolved);
	return parsed.root === resolved;
}

function sanitizeLine(input: string, maxLen = 200): string {
	return input.replace(/[\r\n]+/g, " ").trim().slice(0, maxLen);
}

export function renderMemoriesMarkdown(opts: {
	readonly userName?: string | undefined;
	readonly useCases?: readonly string[] | undefined;
	readonly today: string;
}): string {
	const name = opts.userName ? sanitizeLine(opts.userName, 80) : "";
	const uses = (opts.useCases ?? []).map((u) => sanitizeLine(u, 80)).filter((u) => u.length > 0);
	const aboutLines = [
		name ? `- **Name:** ${name}` : `- **Name:** *(add your name here)*`,
		uses.length > 0 ? `- **Primary use cases:** ${uses.join(", ")}` : `- **Primary use cases:** Projects, notes, and AI workflows in TeezOS`,
	];

	return `---
date: ${opts.today}
description: "Index of memory topics — key decisions, patterns, gotchas, and personal context"
tags:
  - brain
  - index
---

# Memories

Central memory index read by your AI agents across sessions.

## About Me

${aboutLines.join("\n")}

---

## Memory Links

- [[North Star]] — living goals and current focus areas
- [[Key Decisions]] — architectural and workflow decisions worth recalling
- [[Patterns]] — recurring patterns and conventions discovered across work
- [[Gotchas]] — traps that have bitten before and how to avoid them
- [[Skills]] — custom slash commands, Obsidian skills, and Feed the Brain workflows

---

## Recent Context

- ${opts.today}: Initialized Starter Brain in TeezOS. See [[Getting Started with TeezOS]] and [[Index]].
`;
}

export function renderNorthStarMarkdown(opts: {
	readonly userName?: string | undefined;
	readonly goals?: readonly string[] | undefined;
	readonly useCases?: readonly string[] | undefined;
	readonly today: string;
}): string {
	const cleanGoals = (opts.goals ?? []).map((g) => sanitizeLine(g, 180)).filter((g) => g.length > 0).slice(0, 4);
	const heading = opts.userName ? `${sanitizeLine(opts.userName, 80)}'s North Star` : "North Star";
	const goalsList =
		cleanGoals.length > 0
			? cleanGoals.map((g, i) => `${i + 1}. **${g}**`).join("\n")
			: `1. **Build a connected knowledge base in TeezOS** — capture projects, notes, and sources in one graph\n2. **Ship focused work every week** — use \`/om-standup\` and \`/om-wrap-up\` to stay aligned`;

	return `---
date: ${opts.today}
description: "Living document of main goals, active priorities, and focus areas"
tags:
  - brain
  - north-star
---

# ${heading}

Living document of your main goals and focus areas. Both you and your AI agents read and update this note so daily suggestions stay grounded in what matters most.

## Main Goals

${goalsList}

## Current Focus

- [[Getting Started with TeezOS]] — explore your Starter Brain, dock panels, and try Feed the Brain
- Track active work in [[Index]]

## Related

- [[Memories]] · [[Index]] · [[Skills]]
`;
}

function buildStarterFiles(opts: {
	readonly userName?: string | undefined;
	readonly goals?: readonly string[] | undefined;
	readonly useCases?: readonly string[] | undefined;
	readonly today: string;
}): Readonly<Record<string, string>> {
	const { today } = opts;
	return {
		"vault-manifest.json": JSON.stringify(
			{
				name: "TeezOS Starter Brain",
				version: "1.0.0",
				qmd_index: "teezos-brain",
				qmd_context: "Personal Obsidian brain for projects, notes, concepts, and AI context",
			},
			null,
			2,
		) + "\n",

		"Home.md": `---
date: ${today}
description: "Vault entry point — quick navigation to your North Star, active projects, memory topics, and skills"
tags:
  - index
  - moc
---

# Home

Welcome to your **TeezOS Brain** — an Obsidian-compatible knowledge graph that gives Claude Code, Antigravity, and Codex persistent memory across every session.

## Core Brain

- [[North Star]] — your main goals and current priorities
- [[Memories]] — personal context and memory index
- [[Index]] — central map of active projects, notes, and decisions
- [[Skills]] — preloaded Brain & QoL slash commands and skills

## Knowledge & Patterns

- [[Key Decisions]] — architectural and project decisions with rationale
- [[Patterns]] — reusable workflows and conventions
- [[Gotchas]] — edge cases and lessons learned

## Getting Started

- Open [[Getting Started with TeezOS]] for a quick tour of your workspace, commands, and **Feed the Brain**.
`,

		"CLAUDE.md": `# TeezOS Brain

Personal Obsidian vault — an external brain for projects, decisions, sources, concepts, and persistent AI context.

## Core Conventions

1. **Always prefer \`[[wikilinks]]\` over Markdown links** for internal vault connections. Every new note must link to at least one existing note.
2. **Always include YAML frontmatter** with at minimum \`date\`, \`description\` (~150 chars), and \`tags\`.
3. **Where things go:**
   - \`brain/\` — durable operational memory (\`Memories.md\`, \`North Star.md\`, \`Key Decisions.md\`, \`Patterns.md\`, \`Gotchas.md\`, \`Skills.md\`, \`concepts/\`)
   - \`work/active/\` — active projects and work notes (indexed in \`work/Index.md\`)
   - \`work/archive/\` — completed projects
   - \`reference/sources/\` — source notes created by **Feed the Brain** or research
   - \`thinking/\` — scratchpads, drafts, and \`thinking/skill-drafts/\`
   - \`templates/\` — note templates

## Slash Commands (Brain & QoL)

- \`/om-standup\` — Morning kickoff: reads \`Home.md\`, \`brain/North Star.md\`, and \`work/Index.md\` to suggest today's focus
- \`/om-dump\` — Freeform capture: paste rough thoughts or notes and route them into structured, linked vault notes
- \`/om-wrap-up\` — End-of-session review: verifies links, frontmatter, and indexes
- \`/om-weekly\` — Weekly synthesis across your recent notes and North Star goals
- \`/om-vault-audit\` — Structural health check for orphans, broken links, and frontmatter completeness
- \`/om-humanize\` — Voice-calibrated editing so drafted notes sound like you
`,

		"GEMINI.md": `# TeezOS Brain — Antigravity Rules

1. Read \`CLAUDE.md\` at the start of every session for vault conventions, folder layout, and linking rules.
2. Always include YAML frontmatter (\`date\`, \`description\`, \`tags\`) on every note.
3. Every new note must link to at least one existing note using \`[[wikilinks]]\` and be linked from \`work/Index.md\` or \`brain/Memories.md\`.
`,

		"brain/Memories.md": renderMemoriesMarkdown(opts),
		"brain/North Star.md": renderNorthStarMarkdown(opts),

		"brain/Key Decisions.md": `---
date: ${today}
description: "Architectural, project, and workflow decisions worth remembering across sessions"
tags:
  - brain
---

# Key Decisions

Record durable decisions here with a link to the note where they were made.

- **${today} — Initialized TeezOS Starter Brain:** Using a graph-first Obsidian vault for persistent AI context. See [[Getting Started with TeezOS]].

## Related

- [[Memories]] · [[Index]] · [[Patterns]]
`,

		"brain/Patterns.md": `---
date: ${today}
description: "Recurring patterns, conventions, and workflows that work well"
tags:
  - brain
---

# Patterns

Capture reusable patterns and workflows here as you discover them.

- **Graph-first note-taking:** Every note lives in one home folder (\`brain/\`, \`work/active/\`, \`reference/sources/\`) and connects to related notes via \`[[wikilinks]]\`. See [[Home]].

## Related

- [[Memories]] · [[Gotchas]] · [[Key Decisions]]
`,

		"brain/Gotchas.md": `---
date: ${today}
description: "Traps, bugs, and edge cases encountered so they never bite twice"
tags:
  - brain
---

# Gotchas

When something unexpected bites during a project, log the root cause and fix here.

- **Orphan notes hide knowledge:** Always link new notes from [[Index]] or [[Memories]] so they appear in the Brain graph.

## Related

- [[Memories]] · [[Patterns]] · [[Index]]
`,

		"brain/Skills.md": `---
date: ${today}
description: "Bundled Brain & QoL slash commands, Obsidian skills, subagents, and Feed the Brain workflow"
tags:
  - brain
  - index
---

# Skills

Your Starter Brain comes preloaded with brain-oriented and quality-of-life skills in \`.claude/skills/\`, \`.claude/commands/\`, and \`.claude/agents/\`.

## Slash Commands

| Command | Purpose |
|---------|---------|
| \`/om-standup\` | Morning kickoff — loads [[North Star]], [[Index]], and recent activity to suggest priorities |
| \`/om-dump\` | Freeform capture — dump raw notes or ideas and route them to structured vault notes |
| \`/om-wrap-up\` | End-of-session review — verifies frontmatter, \`[[wikilinks]]\`, and index links |
| \`/om-weekly\` | Weekly synthesis — checks alignment between your week's work and [[North Star]] |
| \`/om-vault-audit\` | Deep structural audit — finds orphan notes, broken links, and missing frontmatter |
| \`/om-humanize\` | Voice-calibrated editing — rewrites AI-drafted text to match your natural writing style |

## Bundled Obsidian & Search Skills

- **\`obsidian-markdown\`** — Wikilinks, callouts, embeds, and frontmatter properties
- **\`obsidian-bases\`** — Database-like \`.base\` table and card views
- **\`obsidian-cli\`** — Interact with a running Obsidian app from the CLI
- **\`json-canvas\`** — Visual \`.canvas\` mind maps and flowcharts
- **\`defuddle\`** — Clean Markdown extraction from web articles
- **\`qmd\`** — Local semantic search across your vault

## Feed the Brain

Open the **Feed** panel in TeezOS and paste any YouTube/Instagram video URL, web article, or PDF:
- Source summaries land in \`reference/sources/\`
- Atomic concepts land in \`brain/concepts/\`
- Optional reusable skill drafts land in \`thinking/skill-drafts/\` for your review

## Related

- [[Home]] · [[Memories]] · [[Getting Started with TeezOS]]
`,

		"work/Index.md": `---
date: ${today}
description: "Central map of all work notes — active projects, completed work, and decisions log"
tags:
  - index
  - moc
---

# Work Notes

Central map of content for your projects. All work notes in \`work/active/\` link back here.

## Active Projects

- [[Getting Started with TeezOS]] — quick tour of your Starter Brain, panels, Desks, and slash commands

## Completed

- *(Move finished projects to \`work/archive/\` and list them here)*

## Decisions Log

| Date | Decision | Status | Link |
|------|----------|--------|------|
| ${today} | Set up TeezOS Starter Brain | accepted | [[Getting Started with TeezOS]] |

## Related

- [[Home]] · [[North Star]] · [[Memories]]
`,

		"work/active/Getting Started with TeezOS.md": `---
date: ${today}
quarter: Q4-${today.slice(0, 4)}
description: "Quick-start guide for your TeezOS Starter Brain, dockable panels, Desks, and preloaded slash commands"
project: TeezOS
status: active
tags:
  - work-note
---

# Getting Started with TeezOS

Your Starter Brain is live and connected to the **Brain** view.

## What to Try First

- [ ] **Run \`/om-standup\` in Chat** — your agent will read [[North Star]] and [[Index]] and suggest a plan for today
- [ ] **Explore the Brain graph** — open the **Brain** panel and switch to **Graph** to see how [[Home]], [[Memories]], and [[North Star]] connect
- [ ] **Try Feed the Brain** — open the **Feed** panel and paste a video or article link to turn it into linked notes and concepts
- [ ] **Customize your layout** — drag any panel tab to stack or split views, or pick a preset (*Focus chat*, *Code*, *Vault*) from the top bar

## Related

- [[Home]] · [[North Star]] · [[Memories]] · [[Skills]] · [[Index]]
`,

		"templates/Work Note.md": `---
date: "{{date}}"
description: "Brief ~150 char summary of this work note"
project:
status: active
tags:
  - work-note
---

# {{title}}

## Context

## Notes

## Action Items
- [ ]

## Related
- [[Index]]
`,

		"templates/Decision Record.md": `---
date: "{{date}}"
description: "Decision record and rationale"
status: proposed
tags:
  - decision
---

# Decision: {{title}}

## Context

## Options Considered
1.
2.

## Decision

## Consequences

## Related
- [[Index]] · [[Key Decisions]]
`,

		"templates/Thinking Note.md": `---
date: "{{date}}"
description: "Scratchpad for reasoning and analysis before promoting to permanent notes"
tags:
  - thinking
---

# {{title}}

## Question / Problem

## Analysis

## Next Steps
- [ ]

## Related
- [[Index]]
`,

		".claude/commands/om-standup.md": `---
description: "Morning kickoff. Load today's context, review recent activity, surface open tasks, and identify priorities."
---

Run the morning standup:

1. Read \`Home.md\` for current dashboard state
2. Read \`brain/North Star.md\` for current goals
3. Check \`work/Index.md\` for active projects
4. Check recent git activity if in a git repo: \`git log --oneline -n 10 --no-merges\`
5. List open tasks across \`work/active/*.md\`

Present a concise standup summary:
- **Recent Progress**: What changed recently
- **Active Work**: Current projects in \`work/active/\`
- **Open Tasks**: Pending checkboxes
- **North Star Alignment**: How active work maps to your main goals
- **Suggested Focus**: Top 1-2 priorities for today
`,

		".claude/commands/om-dump.md": `---
description: "Freeform capture mode. Dump anything — ideas, decisions, project updates, notes — and route it to the right vault notes with frontmatter and wikilinks."
---

Process the following freeform dump. For each distinct piece of information:

1. **Classify** it: project update, decision, pattern/gotcha, goal shift, or general work note.
2. **Check existing notes** in \`work/active/\` and \`brain/\` first — prefer updating an existing note over creating duplicates.
3. **Create or update** the appropriate note following \`CLAUDE.md\` conventions:
   - Correct folder placement (\`work/active/\`, \`brain/\`, \`reference/\`)
   - Complete YAML frontmatter (\`date\`, \`description\`, \`tags\`)
   - Outbound \`[[wikilinks]]\` to related notes
4. **Update indexes** (\`work/Index.md\`, \`brain/Memories.md\`) so no note is an orphan.

Content to process:
$ARGUMENTS
`,

		".claude/commands/om-wrap-up.md": `---
description: "End-of-session review. Verify notes created or updated this session, check frontmatter and wikilinks, update indexes, and summarize."
---

Run a session wrap-up:

1. **Review What Was Done**: List notes created or modified in this session.
2. **Verify Note Quality**: Check that every touched note has YAML frontmatter (\`date\`, \`description\`, \`tags\`) and at least one \`[[wikilink]]\`.
3. **Check Index Consistency**: Ensure new work notes are listed in \`work/Index.md\` and durable learnings are in \`brain/Memories.md\`, \`brain/Patterns.md\`, \`brain/Gotchas.md\`, or \`brain/Key Decisions.md\`.
4. **Archive Check**: Move any completed projects from \`work/active/\` to \`work/archive/\`.
5. **Summary**: Report what was captured, any issues fixed, and suggested next steps.
`,

		".claude/commands/om-weekly.md": `---
description: "Weekly synthesis — cross-session review of vault activity, North Star alignment, patterns, and next week's priorities."
---

Run a weekly synthesis across the vault:

1. Check notes modified in the past 7 days across \`work/\`, \`brain/\`, and \`reference/sources/\`.
2. Compare actual activity against \`brain/North Star.md\`:
   - **Aligned work**: Which goals got attention this week?
   - **Silent goals**: Which goals had zero updates?
   - **Emerging themes**: Recurring topics across notes or Feed sources.
3. Present a concise synthesis:
   - **This Week**: 3-5 bullet summary
   - **North Star Check**: On-track vs. silent goals
   - **Patterns & Insights**: Connections worth noting
   - **Suggested Priorities**: Focus areas for next week
`,

		".claude/commands/om-vault-audit.md": `---
description: "Deep structural audit of the vault — checks indexes, frontmatter, broken wikilinks, and orphan notes."
---

Run a structural health check on the vault (using \`vault-librarian\` and \`cross-linker\` when helpful):

1. **Orphan Check**: Find any \`.md\` notes in \`brain/\`, \`work/\`, or \`reference/\` with zero incoming \`[[wikilinks]]\`.
2. **Broken Links**: Scan all \`[[wikilinks]]\` and flag any target notes that do not exist.
3. **Frontmatter Check**: Verify all notes have \`date\`, \`description\`, and \`tags\`.
4. **Index Check**: Confirm every active note in \`work/active/\` is linked in \`work/Index.md\`.
5. Fix clear formatting/frontmatter issues and present a concise report of findings.
`,

		".claude/commands/om-humanize.md": `---
description: "Voice-calibrated editing — rewrites AI-drafted note text so it sounds natural, direct, and human."
---

Edit the specified note in-place so it reads naturally and directly:

1. Read \`brain/North Star.md\` and \`brain/Memories.md\` to calibrate tone.
2. Rewrite padded or hedged phrasing into clear, direct statements while preserving all facts, YAML frontmatter, \`[[wikilinks]]\`, callouts, code blocks, and tables untouched.
3. Remove AI clichés ("Notably", "It's worth noting", "leveraged", "delve", "testament to").
4. Summarize the tone shift and 2-3 key rewrites.

Target note:
$ARGUMENTS
`,

		".claude/skills/obsidian-markdown/SKILL.md": `---
name: obsidian-markdown
description: Create and edit Obsidian Flavored Markdown with wikilinks, embeds, callouts, properties, and frontmatter.
---

# Obsidian Flavored Markdown

- Use \`[[Note Name]]\`, \`[[Note Name|Display Text]]\`, and \`[[Note Name#Heading]]\` for internal vault links.
- Use \`![[Note Name]]\` or \`![[image.png|400]]\` for inline embeds.
- Use callouts with \`> [!note]\`, \`> [!tip]\`, \`> [!warning]\`, \`> [!important]\`.
- Always include YAML frontmatter at the top of every note (\`date\`, \`description\`, \`tags\`).
`,

		".claude/skills/obsidian-bases/SKILL.md": `---
name: obsidian-bases
description: Create and edit Obsidian Bases (.base files) with table/card views, filters, and formulas.
---

# Obsidian Bases (.base)

\`.base\` files are YAML definitions that query vault notes by tag, folder, or frontmatter property:

\`\`\`yaml
filters:
  and:
    - file.inFolder("work/active")
views:
  - type: table
    name: "Active Work"
    order:
      - file.name
      - status
      - date
      - description
\`\`\`
`,

		".claude/skills/obsidian-cli/SKILL.md": `---
name: obsidian-cli
description: Interact with a running Obsidian instance via the obsidian CLI to search, read, create, and inspect notes.
---

# Obsidian CLI

When Obsidian is open, use \`obsidian search query="..."\`, \`obsidian read file="Note"\`, \`obsidian backlinks file="Note"\`, and \`obsidian orphans\` for vault-aware operations. When Obsidian is not running, use standard file reads and grep.
`,

		".claude/skills/json-canvas/SKILL.md": `---
name: json-canvas
description: Create and edit JSON Canvas files (.canvas) with nodes, edges, and groups following the JSON Canvas 1.0 spec.
---

# JSON Canvas (.canvas)

Canvas files contain \`{"nodes": [], "edges": []}\`. Each node requires \`id\` (16-char hex), \`type\` (\`text\`, \`file\`, \`link\`, or \`group\`), \`x\`, \`y\`, \`width\`, and \`height\`. Edges connect \`fromNode\` and \`toNode\`.
`,

		".claude/skills/defuddle/SKILL.md": `---
name: defuddle
description: "Extract clean Markdown content from web pages using Defuddle CLI (defuddle parse <url> --md), removing clutter and navigation."
---

# Defuddle Web Extraction

Use \`defuddle parse <url> --md\` when installed (\`npm install -g defuddle\`) to extract clean readable Markdown from web articles without ads or navigation noise.
`,

		".claude/skills/qmd/SKILL.md": `---
name: qmd
description: "Search the vault using QMD semantic search (mcp__qmd__query or qmd --index <name> query)."
---

# QMD Semantic Search

Check \`vault-manifest.json\` for \`qmd_index\` (default \`teezos-brain\`). Prefer \`mcp__qmd__query\` when registered, or \`qmd --index teezos-brain query "..."\` on the CLI before reading many files manually.
`,

		".claude/agents/context-loader.md": `---
name: context-loader
description: "Load all vault context about a project, concept, or topic — gathers primary notes, backlinks, and mentions into a concise briefing."
tools: Read, Grep, Glob
model: sonnet
maxTurns: 15
skills:
  - obsidian-markdown
  - qmd
---

Given a topic, find its primary note in \`work/\`, \`brain/\`, or \`reference/\`, gather all incoming \`[[wikilinks]]\` and mentions across the vault, and return a concise structured briefing with paths and open items.
`,

		".claude/agents/cross-linker.md": `---
name: cross-linker
description: "Scan vault notes for missing wikilinks, broken links, and orphan notes to strengthen the knowledge graph."
tools: Read, Grep, Glob
model: sonnet
maxTurns: 20
skills:
  - obsidian-markdown
---

Scan notes in \`brain/\`, \`work/\`, and \`reference/\` for unlinked mentions of existing note titles, missing backlinks in \`## Related\` sections, and orphan notes with zero incoming links. Report actionable suggestions grouped by priority.
`,

		".claude/agents/vault-librarian.md": `---
name: vault-librarian
description: "Run vault maintenance: detect orphan notes, broken wikilinks, missing frontmatter, and index drift."
tools: Read, Grep, Glob
model: sonnet
maxTurns: 20
skills:
  - obsidian-markdown
---

Audit the vault for: (1) orphan notes with no incoming \`[[wikilinks]]\`, (2) broken \`[[wikilinks]]\` whose target note does not exist, (3) missing frontmatter fields (\`date\`, \`description\`, \`tags\`), and (4) active notes in \`work/active/\` missing from \`work/Index.md\`.
`,

		"brain/concepts/.gitkeep": "",
		"reference/sources/.gitkeep": "",
		"thinking/skill-drafts/.gitkeep": "",
		"work/archive/.gitkeep": "",
	};
}

/**
 * Generates a Starter Brain vault at `options.targetDir`.
 * Existing files are preserved (`writeIfMissing`), while `brain/Memories.md` and
 * `brain/North Star.md` are updated if the user provided `userName` or `goals`.
 */
export function createStarterBrain(options: StarterBrainOptions): StarterBrainResult {
	const rawTarget = options.targetDir?.trim() ?? "";
	if (!rawTarget || !path.isAbsolute(rawTarget)) {
		return { ok: false, reason: "Target folder must be an absolute path." };
	}
	const resolved = path.resolve(rawTarget);
	if (isUncOrRoot(resolved)) {
		return { ok: false, reason: "Cannot create a Brain at a network share or drive root." };
	}

	try {
		if (existsSync(resolved) && !statSync(resolved).isDirectory()) {
			return { ok: false, reason: "Target path exists and is not a folder." };
		}
		mkdirSync(resolved, { recursive: true });

		const today = options.today ?? new Date().toISOString().slice(0, 10);
		const files = buildStarterFiles({
			userName: options.userName,
			goals: options.goals,
			useCases: options.useCases,
			today,
		});

		const hasPersonalization =
			Boolean(options.userName && options.userName.trim()) ||
			Boolean(options.goals && options.goals.some((g) => g.trim().length > 0)) ||
			Boolean(options.useCases && options.useCases.some((u) => u.trim().length > 0));

		let createdFiles = 0;
		for (const [relPath, content] of Object.entries(files)) {
			const absPath = path.join(resolved, relPath);
			mkdirSync(path.dirname(absPath), { recursive: true });
			const isPersonalNote = relPath === "brain/Memories.md" || relPath === "brain/North Star.md";
			const alreadyExists = existsSync(absPath);
			const isStarterTemplate =
				alreadyExists &&
				isPersonalNote &&
				(() => {
					const existing = readFileSync(absPath, "utf-8");
					return (
						existing.includes("Initialized Starter Brain in TeezOS") ||
						existing.includes("explore your Starter Brain, dock panels, and try Feed the Brain")
					);
				})();
			if (!alreadyExists || (isStarterTemplate && hasPersonalization)) {
				writeFileSync(absPath, content, "utf-8");
				createdFiles += 1;
			}
		}

		return { ok: true, path: resolved, createdFiles };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : "Could not create Starter Brain folder." };
	}
}

/**
 * Updates `brain/Memories.md` and `brain/North Star.md` in a Starter Brain with
 * the user's optional name and 1–2 main goals from onboarding.
 * Safe on existing vaults: if the note already has custom content not from the
 * starter template, it prepends/updates without wiping existing notes.
 */
export function personalizeStarterBrain(
	vaultRoot: string,
	options: PersonalizeOptions,
): { readonly ok: boolean; readonly reason?: string } {
	if (!vaultRoot || !path.isAbsolute(vaultRoot)) {
		return { ok: false, reason: "No Brain vault folder is configured." };
	}
	const resolved = path.resolve(vaultRoot);
	if (isUncOrRoot(resolved) || !existsSync(resolved)) {
		return { ok: false, reason: "Brain folder does not exist." };
	}

	const today = options.today ?? new Date().toISOString().slice(0, 10);
	const name = options.userName?.trim() ?? "";
	const goals = (options.goals ?? []).map((g) => g.trim()).filter((g) => g.length > 0);
	const useCases = (options.useCases ?? []).map((u) => u.trim()).filter((u) => u.length > 0);
	if (!name && goals.length === 0 && useCases.length === 0) {
		return { ok: true };
	}

	try {
		const brainDir = path.join(resolved, "brain");
		mkdirSync(brainDir, { recursive: true });

		if (name || useCases.length > 0) {
			const memoriesPath = path.join(brainDir, "Memories.md");
			const existing = existsSync(memoriesPath) ? readFileSync(memoriesPath, "utf-8") : "";
			// Only overwrite if missing or generated by Starter Brain; otherwise leave user's existing Memories.md intact.
			if (!existing || existing.includes("Initialized Starter Brain in TeezOS")) {
				writeFileSync(
					memoriesPath,
					renderMemoriesMarkdown({ userName: name, useCases, today }),
					"utf-8",
				);
			}
		}

		if (goals.length > 0 || name) {
			const northStarPath = path.join(brainDir, "North Star.md");
			const existing = existsSync(northStarPath) ? readFileSync(northStarPath, "utf-8") : "";
			if (!existing || existing.includes("explore your Starter Brain, dock panels, and try Feed the Brain")) {
				writeFileSync(
					northStarPath,
					renderNorthStarMarkdown({ userName: name, goals, useCases, today }),
					"utf-8",
				);
			}
		}

		return { ok: true };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : "Could not personalize Brain notes." };
	}
}
