import { useEffect, useState } from "react";
import {
	BookOpen,
	Bot,
	Brain,
	Check,
	ChevronLeft,
	ChevronRight,
	Code2,
	FolderOpen,
	Globe,
	Rss,
	Server,
	Sparkles,
	Terminal,
	X,
} from "lucide-react";
import { useSettings } from "../state/settings.ts";
import { useBrain } from "../state/brain.ts";
import { useUi } from "../state/ui.ts";
import { Toggle } from "../views/settings/controls.tsx";
import { PanelAnimation } from "./PanelAnimation.tsx";

const USE_CASES = [
	{
		id: "Coding & Software Projects",
		title: "Coding & Software",
		desc: "Build and ship apps with Claude Code, Gemini & Codex alongside Monaco editor, git, and terminal.",
		icon: Code2,
	},
	{
		id: "Second Brain & Knowledge Graph",
		title: "Second Brain & Notes",
		desc: "Obsidian-compatible knowledge graph with persistent AI memory, daily standups, and automatic linking.",
		icon: Brain,
	},
	{
		id: "Study, Research & Feed",
		title: "Research & Feed the Brain",
		desc: "Turn YouTube/Instagram videos, articles, and PDFs into structured source notes and atomic concepts.",
		icon: Rss,
	},
	{
		id: "Homelab & Automation Ops",
		title: "Homelab & Automations",
		desc: "Monitor Proxmox VE guests/UPS/backups and run scheduled 24/7 AI jobs on your home server.",
		icon: Server,
	},
] as const;

const BUNDLED_SKILLS_PREVIEW = [
	{ cmd: "obsidian-skills", detail: "obsidian-markdown, obsidian-bases, obsidian-cli, json-canvas, defuddle, qmd" },
	{ cmd: "/om-standup", detail: "Morning kickoff — reads North Star & active projects to suggest today's focus" },
	{ cmd: "/om-dump", detail: "Freeform capture — routes rough notes into structured, linked vault notes" },
	{ cmd: "/om-wrap-up", detail: "Session review — checks frontmatter, wikilinks, and indexes" },
	{ cmd: "/om-weekly", detail: "Weekly synthesis — checks progress & drift against your North Star goals" },
	{ cmd: "/om-vault-audit", detail: "Structural health check for orphan notes and broken links" },
	{ cmd: "/om-humanize", detail: "Voice-calibrated editing so drafted notes sound like you" },
	{ cmd: "Feed the Brain", detail: "Pre-configured reference/sources/, brain/concepts/, and thinking/skill-drafts/" },
] as const;

const MODULES_GUIDE = [
	{
		name: "Chat (Claude · Gemini · Codex)",
		shortcut: "Ctrl+J",
		icon: Bot,
		desc: "Run Claude Code, Antigravity (Gemini), or ChatGPT (Codex) on your subscription. Shows live file diffs, tool approval cards, /btw side questions, and plan usage rails.",
	},
	{
		name: "Brain (Vault & Graph)",
		shortcut: "Ctrl+3",
		icon: Brain,
		desc: "Read your Markdown vault with live backlinks, semantic QMD search, and an interactive force-directed graph.",
	},
	{
		name: "Feed the Brain",
		shortcut: "Ctrl+4",
		icon: Rss,
		desc: "Paste any video URL, web article, or PDF. TeezOS extracts a source summary, linked concept notes, and reviewable skill drafts.",
	},
	{
		name: "Editor, Explorer & Terminal",
		shortcut: "Ctrl+1 / Ctrl+`",
		icon: Terminal,
		desc: "Monaco code editor with Markdown preview (Ctrl+Shift+V), file tree (Ctrl+B), git staging, and multi-shell terminal tabs.",
	},
	{
		name: "Browser & Agents Tree",
		shortcut: "Ctrl+5 / Ctrl+6",
		icon: Globe,
		desc: "Sandboxed built-in browser for docs/previews and a live tree of subagents and background runs.",
	},
	{
		name: "Homelab Server & Automations",
		shortcut: "Optional",
		icon: Server,
		desc: "Off by default. Enable anytime if you run a Proxmox VE homelab or teez-runner container for 24/7 scheduled agent jobs.",
	},
] as const;

const STEP_LABELS = [
	"1. Use Case",
	"2. Your Brain",
	"3. Personalize",
	"4. Panels & Desks",
	"5. Modules Tour",
] as const;

export function OnboardingModal({
	onClose,
}: {
	readonly onClose: () => void;
}): React.JSX.Element {
	const settings = useSettings((s) => s.settings);
	const setModules = useSettings((s) => s.setModules);
	const setOnboardingCompleted = useSettings((s) => s.setOnboardingCompleted);
	const toast = useUi((s) => s.toast);

	const [step, setStep] = useState<0 | 1 | 2 | 3 | 4>(0);
	const [selectedUses, setSelectedUses] = useState<string[]>([
		"Coding & Software Projects",
		"Second Brain & Knowledge Graph",
	]);
	const [connectHomelab, setConnectHomelab] = useState<boolean>(
		Boolean(settings?.modules.server.enabled || settings?.modules.automations.enabled),
	);

	// Step 2: Brain setup state
	const [brainMode, setBrainMode] = useState<"starter" | "existing">("starter");
	const [starterDir, setStarterDir] = useState<string>("");
	const [starterExists, setStarterExists] = useState<boolean>(false);
	const [brainReadyPath, setBrainReadyPath] = useState<string | null>(settings?.vaultPath ?? null);
	const [busy, setBusy] = useState<boolean>(false);

	// Step 3: Optional personalization state
	const [userName, setUserName] = useState<string>("");
	const [goal1, setGoal1] = useState<string>("");
	const [goal2, setGoal2] = useState<string>("");

	useEffect(() => {
		void window.teez.brain.defaultStarterPath().then((info) => {
			setStarterDir(info.path);
			setStarterExists(info.exists);
		});
	}, []);

	const toggleUseCase = (id: string): void => {
		setSelectedUses((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
		if (id === "Homelab & Automation Ops" && !selectedUses.includes(id)) {
			handleHomelabToggle(true);
		}
	};

	const handleHomelabToggle = (on: boolean): void => {
		setConnectHomelab(on);
		setModules({
			server: { enabled: on },
			automations: { enabled: on },
		});
	};

	const handlePickStarterLocation = async (): Promise<void> => {
		const chosen = await window.teez.brain.pickParentDir();
		if (chosen) {
			setStarterDir(chosen);
			setStarterExists(false);
		}
	};

	const handleCreateStarterBrain = async (): Promise<boolean> => {
		setBusy(true);
		try {
			const goals = [goal1.trim(), goal2.trim()].filter((g) => g.length > 0);
			const res = await window.teez.brain.createStarter({
				targetDir: starterDir || undefined,
				userName: userName.trim() || undefined,
				goals: goals.length > 0 ? goals : undefined,
				useCases: selectedUses,
			});
			if (!res.ok) {
				toast(res.reason, "error");
				return false;
			}
			setBrainReadyPath(res.workspace.path);
			await useSettings.getState().load();
			void useBrain.getState().refresh();
			toast(`Starter Brain ready at ${res.workspace.path}`, "success");
			return true;
		} finally {
			setBusy(false);
		}
	};

	const handlePickExistingBrain = async (): Promise<void> => {
		setBusy(true);
		try {
			const res = await window.teez.brain.pickExisting();
			if (!res.ok) {
				if (res.reason !== "cancelled") toast(res.reason, "error");
				return;
			}
			setBrainReadyPath(res.workspace.path);
			await useSettings.getState().load();
			void useBrain.getState().refresh();
			toast(`Connected Brain: ${res.workspace.name}`, "success");
			setStep(2);
		} finally {
			setBusy(false);
		}
	};

	const handleStep2Continue = async (): Promise<void> => {
		if (brainMode === "starter") {
			const ok = await handleCreateStarterBrain();
			if (ok) setStep(2);
			return;
		}
		if (brainReadyPath) {
			setStep(2);
			return;
		}
		await handlePickExistingBrain();
	};

	const handlePersonalizeSave = async (): Promise<void> => {
		const goals = [goal1.trim(), goal2.trim()].filter((g) => g.length > 0);
		if (userName.trim() || goals.length > 0) {
			setBusy(true);
			try {
				const res = await window.teez.brain.personalizeStarter({
					userName: userName.trim() || undefined,
					goals,
					useCases: selectedUses,
				});
				if (res.ok) {
					void useBrain.getState().refresh();
					toast("Saved to Memories.md and North Star.md", "success");
				}
			} finally {
				setBusy(false);
			}
		}
		setStep(3);
	};

	const finishOnboarding = (): void => {
		setOnboardingCompleted(true);
		onClose();
	};

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="TeezOS First-Run Setup and Tutorial"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-xs"
		>
			<div className="cut-corner relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden border border-red-hot/50 bg-bg shadow-[0_0_50px_rgba(232,0,45,0.22)]">
				{/* Top Red Accent Bar */}
				<div className="h-1 w-full bg-linear-to-r from-red-hot via-red to-transparent" />

				{/* Modal Header & Stepper */}
				<div className="flex items-center justify-between border-b border-border bg-surface px-6 py-3.5">
					<div className="flex items-center gap-3">
						<span className="skew-band px-2 py-0.5 font-condensed text-[11px] font-bold uppercase tracking-widest text-white">
							TeezOS Setup
						</span>
						<div className="flex items-center gap-1.5">
							{STEP_LABELS.map((label, idx) => {
								const active = idx === step;
								const done = idx < step;
								return (
									<button
										key={label}
										type="button"
										onClick={() => setStep(idx as 0 | 1 | 2 | 3 | 4)}
										className={`px-2.5 py-1 font-condensed text-xs uppercase tracking-wider transition-colors ${
											active
												? "border-b-2 border-red-hot bg-red/15 text-text"
												: done
													? "text-text/80 hover:text-text"
													: "text-muted hover:text-text"
										}`}
									>
										{done ? "✓ " : ""}
										{label}
									</button>
								);
							})}
						</div>
					</div>
					<button
						type="button"
						onClick={finishOnboarding}
						className="flex items-center gap-1.5 font-mono text-[11px] text-muted transition-colors hover:text-red-hot"
					>
						<span>Skip setup</span>
						<X size={14} />
					</button>
				</div>

				{/* Step Body */}
				<div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
					{step === 0 ? (
						<div className="space-y-6">
							<div>
								<p className="font-condensed text-xs uppercase tracking-[0.3em] text-red-hot">
									Welcome to TeezOS
								</p>
								<h2 className="glow-text mt-1 font-display text-4xl tracking-wide">
									WHAT WILL YOU USE TEEZOS FOR?
								</h2>
								<p className="mt-1 font-mono text-xs text-muted">
									Pick one or more so we can tailor your workspace and Starter Brain.
								</p>
							</div>

							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
								{USE_CASES.map((item) => {
									const Icon = item.icon;
									const selected = selectedUses.includes(item.id);
									return (
										<button
											key={item.id}
											type="button"
											onClick={() => toggleUseCase(item.id)}
											className={`cut-corner flex items-start gap-3.5 border p-4 text-left transition-all ${
												selected
													? "border-red-hot bg-red/15 shadow-[0_0_20px_var(--color-glow)]"
													: "border-border bg-surface hover:border-red/40"
											}`}
										>
											<div
												className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border ${
													selected ? "border-red-hot bg-red text-white" : "border-border bg-bg text-muted"
												}`}
											>
												<Icon size={16} />
											</div>
											<div className="min-w-0 flex-1">
												<div className="flex items-center justify-between gap-2">
													<p className="font-condensed text-base font-semibold uppercase tracking-wider text-text">
														{item.title}
													</p>
													{selected ? <Check size={14} className="text-red-hot" /> : null}
												</div>
												<p className="mt-1 font-mono text-[11px] leading-relaxed text-muted">
													{item.desc}
												</p>
											</div>
										</button>
									);
								})}
							</div>

							{/* Optional Homelab Toggle (Off by default) */}
							<div className="flex items-center justify-between gap-4 border border-border bg-surface/80 px-4 py-3.5">
								<div className="space-y-0.5">
									<div className="flex items-center gap-2">
										<Server size={14} className={connectHomelab ? "text-red-hot" : "text-muted"} />
										<span className="font-condensed text-sm uppercase tracking-wider text-text">
											Connect a Homelab (Optional)
										</span>
										<span className="border border-border bg-bg px-1.5 py-0.5 font-mono text-[9.5px] text-muted">
											Off by default
										</span>
									</div>
									<p className="font-mono text-[11px] text-muted">
										Enables the Proxmox Server &amp; 24/7 Automations modules in the sidebar. Leave this off if you don&apos;t run a home server—you can turn it on anytime in Settings.
									</p>
								</div>
								<Toggle
									value={connectHomelab}
									label="Connect a Homelab"
									onChange={handleHomelabToggle}
								/>
							</div>
						</div>
					) : null}

					{step === 1 ? (
						<div className="space-y-5">
							<div>
								<p className="font-condensed text-xs uppercase tracking-[0.3em] text-red-hot">
									Step 2 · Persistent Memory
								</p>
								<h2 className="glow-text mt-1 font-display text-4xl tracking-wide">
									SET UP YOUR BRAIN VAULT
								</h2>
								<p className="mt-1 font-mono text-xs text-muted">
									TeezOS uses a Markdown vault so your AI agents remember your goals, projects, and decisions across every session.
								</p>
							</div>

							{/* Choice: Starter Brain vs Existing Brain */}
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
								<button
									type="button"
									onClick={() => setBrainMode("starter")}
									className={`cut-corner flex flex-col gap-2 border p-4 text-left transition-all ${
										brainMode === "starter"
											? "border-red-hot bg-red/15 shadow-[0_0_20px_var(--color-glow)]"
											: "border-border bg-surface hover:border-red/40"
									}`}
								>
									<div className="flex items-center justify-between">
										<span className="flex items-center gap-2 font-condensed text-base font-semibold uppercase tracking-wider text-text">
											<Sparkles size={15} className="text-red-hot" />
											Generate a Starter Brain
										</span>
										<span className="border border-red-hot/60 bg-red/20 px-1.5 py-0.5 font-mono text-[9.5px] text-text">
											Recommended
										</span>
									</div>
									<p className="font-mono text-[11px] leading-relaxed text-muted">
										Creates a ready-to-use Brain structure with preloaded Obsidian &amp; QoL skills out of the box—no manual setup required.
									</p>
								</button>

								<button
									type="button"
									onClick={() => setBrainMode("existing")}
									className={`cut-corner flex flex-col gap-2 border p-4 text-left transition-all ${
										brainMode === "existing"
											? "border-red-hot bg-red/15 shadow-[0_0_20px_var(--color-glow)]"
											: "border-border bg-surface hover:border-red/40"
									}`}
								>
									<div className="flex items-center justify-between">
										<span className="flex items-center gap-2 font-condensed text-base font-semibold uppercase tracking-wider text-text">
											<FolderOpen size={15} className="text-red-hot" />
											I Already Have a Brain
										</span>
									</div>
									<p className="font-mono text-[11px] leading-relaxed text-muted">
										Point TeezOS at an existing Obsidian vault or Markdown notes folder on your disk.
									</p>
								</button>
							</div>

							{brainMode === "starter" ? (
								<div className="space-y-4 border border-border bg-surface/70 p-4">
									<div className="flex flex-wrap items-center justify-between gap-3">
										<div>
											<p className="font-condensed text-xs uppercase tracking-wider text-muted">
												Starter Brain Location
											</p>
											<p className="mt-0.5 font-mono text-xs text-text">{starterDir || "~/TeezMind"}</p>
											{starterExists ? (
												<p className="mt-0.5 font-mono text-[10.5px] text-muted">
													Folder already exists — existing notes will be preserved while missing starter files &amp; skills are added.
												</p>
											) : null}
										</div>
										<button
											type="button"
											onClick={() => void handlePickStarterLocation()}
											className="cut-corner border border-border bg-bg px-3 py-1.5 font-condensed text-xs uppercase tracking-wider text-text hover:border-red/60"
										>
											Change Folder…
										</button>
									</div>

									<div className="border-t border-border pt-3">
										<p className="mb-2 font-condensed text-xs uppercase tracking-wider text-red-hot">
											Preloaded Out of the Box (Brain &amp; QoL Skills Only)
										</p>
										<div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
											{BUNDLED_SKILLS_PREVIEW.map((item) => (
												<div
													key={item.cmd}
													className="flex items-start gap-2 border border-border/70 bg-bg/60 px-2.5 py-1.5 font-mono text-[10.5px]"
												>
													<span className="shrink-0 font-semibold text-red-hot">{item.cmd}</span>
													<span className="text-muted">— {item.detail}</span>
												</div>
											))}
										</div>
									</div>
								</div>
							) : (
								<div className="flex flex-wrap items-center justify-between gap-4 border border-border bg-surface/70 p-4">
									<div>
										<p className="font-condensed text-xs uppercase tracking-wider text-muted">
											Current Brain Folder
										</p>
										<p className="mt-0.5 font-mono text-xs text-text">
											{brainReadyPath ?? "No folder selected yet"}
										</p>
									</div>
									<button
										type="button"
										onClick={() => void handlePickExistingBrain()}
										disabled={busy}
										className="cut-corner btn-hot px-4 py-1.5 font-condensed text-xs uppercase tracking-wider text-white"
									>
										Browse for Vault Folder…
									</button>
								</div>
							)}
						</div>
					) : null}

					{step === 2 ? (
						<div className="space-y-5">
							<div className="flex items-start justify-between gap-4">
								<div>
									<p className="font-condensed text-xs uppercase tracking-[0.3em] text-red-hot">
										Step 3 · Optional Personalization
									</p>
									<h2 className="glow-text mt-1 font-display text-4xl tracking-wide">
										PRE-FILL MEMORIES &amp; NORTH STAR
									</h2>
									<p className="mt-1 font-mono text-xs text-muted">
										Optional: enter your name and 1–2 main goals to pre-fill <span className="text-text">brain/Memories.md</span> and <span className="text-text">brain/North Star.md</span>, or hit Skip to do it later.
									</p>
								</div>
								<button
									type="button"
									onClick={() => setStep(3)}
									className="cut-corner shrink-0 border border-border bg-surface px-4 py-1.5 font-condensed text-xs uppercase tracking-wider text-muted hover:border-red/60 hover:text-text"
								>
									Skip for now →
								</button>
							</div>

							<div className="space-y-4 border border-border bg-surface/70 p-5">
								<div>
									<label
										htmlFor="onboarding-user-name"
										className="block font-condensed text-xs uppercase tracking-wider text-text"
									>
										Your Name <span className="text-muted">(Optional — written to Memories.md)</span>
									</label>
									<input
										id="onboarding-user-name"
										type="text"
										value={userName}
										onChange={(e) => setUserName(e.target.value)}
										placeholder="e.g. Alex"
										className="mt-1.5 w-full border border-border bg-bg px-3 py-2 font-mono text-xs text-text focus:border-red-hot focus:outline-none"
									/>
								</div>

								<div>
									<label
										htmlFor="onboarding-goal-1"
										className="block font-condensed text-xs uppercase tracking-wider text-text"
									>
										Main Goal #1 <span className="text-muted">(Optional — written to North Star.md)</span>
									</label>
									<input
										id="onboarding-goal-1"
										type="text"
										value={goal1}
										onChange={(e) => setGoal1(e.target.value)}
										placeholder="e.g. Launch my web app MVP by next month"
										className="mt-1.5 w-full border border-border bg-bg px-3 py-2 font-mono text-xs text-text focus:border-red-hot focus:outline-none"
									/>
								</div>

								<div>
									<label
										htmlFor="onboarding-goal-2"
										className="block font-condensed text-xs uppercase tracking-wider text-text"
									>
										Main Goal #2 <span className="text-muted">(Optional — written to North Star.md)</span>
									</label>
									<input
										id="onboarding-goal-2"
										type="text"
										value={goal2}
										onChange={(e) => setGoal2(e.target.value)}
										placeholder="e.g. Organize all study & research notes in one connected graph"
										className="mt-1.5 w-full border border-border bg-bg px-3 py-2 font-mono text-xs text-text focus:border-red-hot focus:outline-none"
									/>
								</div>
							</div>
						</div>
					) : null}

					{step === 3 ? (
						<div className="space-y-4">
							<div>
								<p className="font-condensed text-xs uppercase tracking-[0.3em] text-red-hot">
									Step 4 · Interactive Layout Guide
								</p>
								<h2 className="glow-text mt-1 font-display text-4xl tracking-wide">
									DOCKING, SPLITTING PANELS &amp; DESKS
								</h2>
								<p className="mt-1 font-mono text-xs text-muted">
									Every panel in TeezOS is a modular tab (like OBS Docks). Drag tabs to stack or split panels, and use Desks in the top bar to keep separate layouts per project.
								</p>
							</div>

							<PanelAnimation />
						</div>
					) : null}

					{step === 4 ? (
						<div className="space-y-5">
							<div>
								<p className="font-condensed text-xs uppercase tracking-[0.3em] text-red-hot">
									Step 5 · Workbench Modules
								</p>
								<h2 className="glow-text mt-1 font-display text-4xl tracking-wide">
									WHAT EACH MODULE DOES
								</h2>
								<p className="mt-1 font-mono text-xs text-muted">
									Every module can be toggled on or off anytime under <span className="text-text">Settings (Ctrl+,)</span>.
								</p>
							</div>

							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
								{MODULES_GUIDE.map((m) => {
									const Icon = m.icon;
									return (
										<div
											key={m.name}
											className="flex items-start gap-3 border border-border bg-surface/80 p-3.5"
										>
											<div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border border-red-hot/50 bg-red/15 text-red-hot">
												<Icon size={15} />
											</div>
											<div className="min-w-0 flex-1">
												<div className="flex items-center justify-between gap-2">
													<p className="font-condensed text-sm font-semibold uppercase tracking-wider text-text">
														{m.name}
													</p>
													<span className="border border-border bg-bg px-1.5 py-0.5 font-mono text-[9.5px] text-muted">
														{m.shortcut}
													</span>
												</div>
												<p className="mt-1 font-mono text-[11px] leading-relaxed text-muted">
													{m.desc}
												</p>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					) : null}
				</div>

				{/* Footer Navigation */}
				<div className="flex items-center justify-between border-t border-border bg-surface px-6 py-3.5">
					<div>
						{step > 0 ? (
							<button
								type="button"
								onClick={() => setStep((s) => (s - 1) as 0 | 1 | 2 | 3 | 4)}
								className="cut-corner flex items-center gap-1.5 border border-border bg-bg px-3.5 py-1.5 font-condensed text-xs uppercase tracking-wider text-muted hover:border-red/50 hover:text-text"
							>
								<ChevronLeft size={14} />
								<span>Back</span>
							</button>
						) : (
							<span className="font-mono text-[11px] text-muted">
								Reopen anytime from Settings → General
							</span>
						)}
					</div>

					<div className="flex items-center gap-3">
						{step === 0 ? (
							<button
								type="button"
								onClick={() => setStep(1)}
								className="cut-corner btn-hot flex items-center gap-1.5 px-5 py-1.5 font-condensed text-xs uppercase tracking-wider text-white"
							>
								<span>Continue to Brain Setup</span>
								<ChevronRight size={14} />
							</button>
						) : null}

						{step === 1 ? (
							<button
								type="button"
								disabled={busy}
								onClick={() => void handleStep2Continue()}
								className="cut-corner btn-hot flex items-center gap-1.5 px-5 py-1.5 font-condensed text-xs uppercase tracking-wider text-white disabled:opacity-50"
							>
								<span>
									{busy
										? "Setting up Brain…"
										: brainMode === "starter"
											? "Generate Starter Brain & Continue"
											: brainReadyPath
												? "Use Selected Brain & Continue"
												: "Select Brain Folder…"}
								</span>
								<ChevronRight size={14} />
							</button>
						) : null}

						{step === 2 ? (
							<>
								<button
									type="button"
									onClick={() => setStep(3)}
									className="cut-corner border border-border bg-bg px-4 py-1.5 font-condensed text-xs uppercase tracking-wider text-muted hover:border-red/50 hover:text-text"
								>
									Skip
								</button>
								<button
									type="button"
									disabled={busy}
									onClick={() => void handlePersonalizeSave()}
									className="cut-corner btn-hot flex items-center gap-1.5 px-5 py-1.5 font-condensed text-xs uppercase tracking-wider text-white disabled:opacity-50"
								>
									<span>Save &amp; Continue</span>
									<ChevronRight size={14} />
								</button>
							</>
						) : null}

						{step === 3 ? (
							<button
								type="button"
								onClick={() => setStep(4)}
								className="cut-corner btn-hot flex items-center gap-1.5 px-5 py-1.5 font-condensed text-xs uppercase tracking-wider text-white"
							>
								<span>Next: Modules Tour</span>
								<ChevronRight size={14} />
							</button>
						) : null}

						{step === 4 ? (
							<button
								type="button"
								onClick={finishOnboarding}
								className="cut-corner btn-hot flex items-center gap-2 px-6 py-1.5 font-condensed text-xs uppercase tracking-wider text-white"
							>
								<BookOpen size={14} />
								<span>Launch TeezOS</span>
							</button>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}
