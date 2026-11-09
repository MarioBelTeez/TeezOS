import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Columns2, Layers, LayoutGrid, MousePointer2, Pause, Play } from "lucide-react";

export type DemoMode = "split" | "stack" | "desks";

const DEMO_MODES: readonly {
	readonly id: DemoMode;
	readonly label: string;
	readonly subtitle: string;
	readonly icon: typeof Columns2;
}[] = [
	{
		id: "split",
		label: "1. Split Panels",
		subtitle: "Drag any tab to the left, right, top, or bottom edge of a panel to split the workspace side-by-side.",
		icon: Columns2,
	},
	{
		id: "stack",
		label: "2. Stack & Dock Tabs",
		subtitle: "Drop a tab onto another panel's header bar to stack them together, or toggle panels from the top-right Docks menu.",
		icon: Layers,
	},
	{
		id: "desks",
		label: "3. Desks & Presets",
		subtitle: "Each Desk in the title bar is a project with its own saved panel layout. Switch Desks or apply a Preset in one click.",
		icon: LayoutGrid,
	},
];

/**
 * Visual animated demonstration of dragging/splitting dockview panels and switching Desks.
 */
export function PanelAnimation(): React.JSX.Element {
	const [mode, setMode] = useState<DemoMode>("split");
	const [phase, setPhase] = useState<0 | 1 | 2>(0);
	const [playing, setPlaying] = useState(true);

	useEffect(() => {
		if (!playing) return;
		const timer = setInterval(() => {
			setPhase((prev) => {
				if (prev < 2) return (prev + 1) as 0 | 1 | 2;
				setMode((currentMode) => {
					const idx = DEMO_MODES.findIndex((m) => m.id === currentMode);
					return DEMO_MODES[(idx + 1) % DEMO_MODES.length]?.id ?? "split";
				});
				return 0;
			});
		}, 2100);
		return () => clearInterval(timer);
	}, [playing]);

	const selectMode = (next: DemoMode): void => {
		setMode(next);
		setPhase(0);
	};

	const activeMeta = DEMO_MODES.find((m) => m.id === mode) ?? DEMO_MODES[0]!;

	return (
		<div className="flex flex-col gap-3">
			{/* Mode selector tabs */}
			<div className="flex flex-wrap items-center gap-2">
				{DEMO_MODES.map((item) => {
					const Icon = item.icon;
					const active = item.id === mode;
					return (
						<button
							key={item.id}
							type="button"
							onClick={() => selectMode(item.id)}
							className={`cut-corner flex items-center gap-2 border px-3 py-1.5 font-condensed text-xs uppercase tracking-wider transition-all ${
								active
									? "border-red-hot bg-red/20 text-text shadow-[0_0_16px_var(--color-glow)]"
									: "border-border bg-surface text-muted hover:border-red/40 hover:text-text"
							}`}
						>
							<Icon size={13} className={active ? "text-red-hot" : "text-muted"} />
							<span>{item.label}</span>
						</button>
					);
				})}
				<div className="flex-1" />
				<button
					type="button"
					onClick={() => setPlaying((p) => !p)}
					title={playing ? "Pause animation" : "Play animation"}
					className="flex items-center gap-1.5 border border-border bg-surface px-2.5 py-1 font-mono text-[10px] text-muted hover:border-red/50 hover:text-text"
				>
					{playing ? <Pause size={11} /> : <Play size={11} />}
					<span>{playing ? "Auto-cycling" : "Paused"}</span>
				</button>
			</div>

			{/* Simulated TeezOS Window Stage */}
			<div className="relative h-64 w-full overflow-hidden border border-border bg-[#070509] shadow-inner">
				{/* Simulated Top Title Bar with Desks & Presets */}
				<div className="flex h-8 items-center gap-2 border-b border-border bg-surface px-3 font-mono text-[10px]">
					<span className="h-2 w-2 bg-red-hot shadow-[0_0_8px_var(--color-glow)]" />
					<span className="font-display text-xs tracking-wider text-text">TEEZMIND</span>

					{/* Simulated Desk Tabs */}
					<div className="ml-2 flex items-center gap-1">
						<div
							className={`px-2 py-0.5 font-condensed text-[11px] uppercase tracking-wider transition-colors ${
								mode === "desks" && phase === 2
									? "border border-border bg-bg text-muted"
									: "border border-red-hot/70 bg-red/20 text-text"
							}`}
						>
							Desk 1 · TeezMind
						</div>
						<AnimatePresence>
							{(mode === "desks" && phase >= 1) ? (
								<motion.div
									initial={{ opacity: 0, scale: 0.85, x: -8 }}
									animate={{ opacity: 1, scale: 1, x: 0 }}
									exit={{ opacity: 0, scale: 0.85 }}
									className={`px-2 py-0.5 font-condensed text-[11px] uppercase tracking-wider ${
										phase === 2
											? "border border-red-hot bg-red/25 text-text shadow-[0_0_12px_var(--color-glow)]"
											: "border border-border bg-bg text-muted"
									}`}
								>
									Desk 2 · Web App
								</motion.div>
							) : null}
						</AnimatePresence>
						<span className="border border-border bg-bg px-1.5 py-0.5 text-[10px] text-muted">+</span>
					</div>

					{/* Preset Pill */}
					<div
						className={`ml-2 border px-2 py-0.5 font-condensed text-[10px] uppercase tracking-wider transition-colors ${
							mode === "desks" && phase === 2
								? "border-red-hot bg-red/20 text-red-hot"
								: "border-border bg-bg text-muted"
						}`}
					>
						Preset: {mode === "desks" && phase === 2 ? "Code + Terminal" : "Vault + Chat"}
					</div>

					<div className="flex-1" />
					<div className="border border-border bg-bg px-2 py-0.5 text-[9px] text-muted">Docks ▾</div>
				</div>

				{/* Simulated Dockview Grid */}
				<div className="relative flex h-[calc(100%-2rem)] w-full p-2 gap-2">
					{/* Left Explorer column */}
					<div className="flex w-32 shrink-0 flex-col border border-border bg-surface/70">
						<div className="flex h-6 items-center gap-1.5 border-b border-border bg-surface px-2 font-condensed text-[10px] uppercase tracking-wider text-muted">
							<span className="text-red-hot">■</span> Explorer
						</div>
						<div className="flex flex-col gap-1 p-2 font-mono text-[9.5px] text-muted">
							{mode === "desks" && phase === 2 ? (
								<>
									<span className="text-text">▾ src/</span>
									<span className="pl-2">App.tsx</span>
									<span className="pl-2">main.ts</span>
									<span>package.json</span>
								</>
							) : (
								<>
									<span className="text-text">▾ brain/</span>
									<span className="pl-2 text-red-hot">North Star.md</span>
									<span className="pl-2">Memories.md</span>
									<span>Home.md</span>
								</>
							)}
						</div>
					</div>

					{/* Main Dynamic Area */}
					<div className="relative flex flex-1 gap-2">
						{mode === "split" ? (
							<>
								{/* Left / Full Panel (Chat) */}
								<motion.div
									layout
									transition={{ type: "spring", stiffness: 260, damping: 26 }}
									className="flex flex-1 flex-col border border-border bg-surface/60"
								>
									<div className="flex h-6 items-center gap-1 border-b border-border bg-surface px-2 font-condensed text-[10px] uppercase tracking-wider">
										<span className="border-b border-red-hot px-1.5 py-0.5 text-text">Chat</span>
										{phase === 0 ? (
											<span className="border border-red-hot/60 bg-red/20 px-1.5 py-0.5 text-text">
												Brain
											</span>
										) : null}
									</div>
									<div className="flex flex-1 flex-col justify-between p-2.5 font-mono text-[10px] text-muted">
										<div className="space-y-1.5">
											<div className="border-l-2 border-red-hot pl-2 text-text">
												/om-standup — loaded North Star.md
											</div>
											<div className="text-[9.5px] text-muted">
												Drag the &quot;Brain&quot; tab to the right edge to split side-by-side…
											</div>
										</div>
										<div className="border border-border bg-bg px-2 py-1 text-[9px] text-muted">
											Ask Claude, Gemini, or ChatGPT…
										</div>
									</div>
								</motion.div>

								{/* Right Drop Highlight (Phase 1) */}
								<AnimatePresence>
									{phase === 1 ? (
										<motion.div
											initial={{ opacity: 0, width: 0 }}
											animate={{ opacity: 1, width: "46%" }}
											exit={{ opacity: 0, width: 0 }}
											className="pointer-events-none absolute top-0 right-0 bottom-0 border-2 border-dashed border-red-hot bg-red/15 shadow-[inset_0_0_24px_var(--color-glow)]"
										>
											<div className="flex h-full items-center justify-center font-condensed text-xs uppercase tracking-widest text-red-hot">
												Drop on Edge to Split Right
											</div>
										</motion.div>
									) : null}
								</AnimatePresence>

								{/* Split Brain Panel (Phase 2) */}
								<AnimatePresence>
									{phase === 2 ? (
										<motion.div
											initial={{ opacity: 0, width: "0%" }}
											animate={{ opacity: 1, width: "48%" }}
											exit={{ opacity: 0, width: "0%" }}
											className="flex flex-col border border-red-hot/60 bg-surface/80 shadow-[0_0_18px_var(--color-glow)]"
										>
											<div className="flex h-6 items-center justify-between border-b border-border bg-surface px-2 font-condensed text-[10px] uppercase tracking-wider">
												<span className="border-b border-red-hot px-1.5 py-0.5 text-text">Brain · Graph</span>
												<span className="font-mono text-[9px] text-red-hot">SPLIT ACTIVE</span>
											</div>
											<div className="relative flex flex-1 items-center justify-center p-2">
												<svg className="h-24 w-full" viewBox="0 0 160 80">
													<line x1="40" y1="40" x2="85" y2="22" stroke="#e8002d" strokeOpacity="0.5" strokeWidth="1.2" />
													<line x1="40" y1="40" x2="85" y2="58" stroke="#e8002d" strokeOpacity="0.5" strokeWidth="1.2" />
													<line x1="85" y1="22" x2="128" y2="40" stroke="#6b5b62" strokeOpacity="0.6" strokeWidth="1" />
													<circle cx="40" cy="40" r="6" fill="#e8002d" />
													<circle cx="85" cy="22" r="5" fill="#f5f0f2" />
													<circle cx="85" cy="58" r="5" fill="#f5f0f2" />
													<circle cx="128" cy="40" r="4.5" fill="#6b5b62" />
													<text x="22" y="56" fill="#f5f0f2" fontSize="7" fontFamily="monospace">Home</text>
													<text x="68" y="13" fill="#f5f0f2" fontSize="7" fontFamily="monospace">North Star</text>
													<text x="68" y="72" fill="#f5f0f2" fontSize="7" fontFamily="monospace">Memories</text>
												</svg>
											</div>
										</motion.div>
									) : null}
								</AnimatePresence>
							</>
						) : mode === "stack" ? (
							<>
								<div className="flex flex-1 flex-col border border-border bg-surface/60">
									<div
										className={`flex h-6 items-center gap-1.5 border-b px-2 font-condensed text-[10px] uppercase tracking-wider transition-colors ${
											phase === 1 ? "border-red-hot bg-red/20" : "border-border bg-surface"
										}`}
									>
										<span className="px-1.5 py-0.5 text-muted">Chat</span>
										<span className="px-1.5 py-0.5 text-muted">Brain</span>
										{phase === 2 ? (
											<motion.span
												initial={{ scale: 0.85, opacity: 0 }}
												animate={{ scale: 1, opacity: 1 }}
												className="border-b border-red-hot bg-red/20 px-1.5 py-0.5 text-text"
											>
												Feed the Brain
											</motion.span>
										) : null}
										{phase === 1 ? (
											<span className="ml-auto font-mono text-[9px] text-red-hot">DROP ON HEADER TO STACK TAB</span>
										) : null}
									</div>
									<div className="flex flex-1 flex-col justify-center gap-2 p-3 font-mono text-[10px]">
										{phase < 2 ? (
											<div className="flex items-center justify-between border border-dashed border-border p-3 text-muted">
												<span>Dragging &quot;Feed the Brain&quot; tab onto panel tab strip…</span>
												<span className="border border-red-hot/60 bg-red/15 px-2 py-0.5 text-text">
													Feed the Brain
												</span>
											</div>
										) : (
											<div className="space-y-1.5 border border-red-hot/40 bg-bg/70 p-2.5">
												<div className="text-red-hot">FEED THE BRAIN · STACKED TAB</div>
												<div className="text-muted">
													Paste a YouTube video, article URL, or PDF → auto-generates linked source notes &amp; concepts.
												</div>
											</div>
										)}
									</div>
								</div>
							</>
						) : (
							/* mode === "desks" */
							<div className="flex flex-1 gap-2">
								<div className="flex flex-1 flex-col border border-border bg-surface/60 p-3 font-mono text-[10px]">
									<div className="mb-1 font-condensed text-xs uppercase tracking-wider text-red-hot">
										{phase === 2 ? "Desk 2 · Web App (Code + Terminal Layout)" : "Desk 1 · TeezMind (Brain + Chat Layout)"}
									</div>
									<p className="text-muted leading-relaxed">
										{phase === 2
											? "Switched to Desk 2: Editor + Terminal open automatically for your code repo while Desk 1 keeps your Brain & Chat layout untouched."
											: "Click '+' in the top bar to open another Desk for a second project, or pick a Preset to rearrange panels immediately."}
									</p>
									<div className="mt-auto flex items-center gap-2 pt-2 text-[9.5px] text-muted">
										<span className="border border-border bg-bg px-2 py-0.5">Ctrl+T: New Desk</span>
										<span className="border border-border bg-bg px-2 py-0.5">Ctrl+Tab: Cycle Desks</span>
										<span className="border border-border bg-bg px-2 py-0.5">Alt+1..9: Jump to Desk</span>
									</div>
								</div>
							</div>
						)}

						{/* Animated Pointer Cursor */}
						<motion.div
							key={`${mode}-${phase}`}
							initial={
								mode === "split"
									? { x: 110, y: 12 }
									: mode === "stack"
										? { x: 260, y: 95 }
										: { x: 145, y: -22 }
							}
							animate={
								mode === "split"
									? phase === 0
										? { x: 110, y: 12 }
										: phase === 1
											? { x: 340, y: 85 }
											: { x: 310, y: 70 }
									: mode === "stack"
										? phase === 0
											? { x: 260, y: 95 }
											: phase === 1
												? { x: 155, y: 10 }
												: { x: 145, y: 12 }
										: phase === 0
											? { x: 145, y: -22 }
											: phase === 1
												? { x: 215, y: -22 }
												: { x: 310, y: -22 }
							}
							transition={{ duration: 0.75, ease: "easeInOut" }}
							className="pointer-events-none absolute z-20 flex items-center gap-1"
						>
							<MousePointer2 size={16} className="fill-red-hot text-white drop-shadow-[0_0_8px_rgba(232,0,45,0.9)]" />
							{(mode === "split" && phase === 1) || (mode === "stack" && phase === 1) ? (
								<span className="border border-red-hot bg-bg/95 px-1.5 py-0.5 font-condensed text-[9px] uppercase tracking-wider text-text shadow-lg">
									{mode === "split" ? "Brain" : "Feed"}
								</span>
							) : null}
						</motion.div>
					</div>
				</div>
			</div>

			{/* Caption bar */}
			<div className="flex items-center justify-between border border-border bg-surface/60 px-3 py-2">
				<p className="font-mono text-[11px] text-muted">{activeMeta.subtitle}</p>
				<span className="ml-3 shrink-0 font-mono text-[10px] text-red-hot">
					Step {phase + 1} / 3
				</span>
			</div>
		</div>
	);
}
