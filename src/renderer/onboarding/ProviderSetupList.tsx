import { useCallback, useEffect, useState } from "react";
import { Check, Download, ExternalLink, RefreshCw } from "lucide-react";
import type { ExtrasStatus, ProviderId, ProviderState } from "../../main/agents/setup.ts";
import { useUi } from "../state/ui.ts";

const AI_PROVIDERS: readonly {
	readonly id: ProviderId;
	readonly name: string;
	readonly subtitle: string;
	readonly installable: boolean;
}[] = [
	{
		id: "claude",
		name: "Claude (Anthropic)",
		subtitle: "Uses your Claude Pro/Max subscription. Best all-rounder for coding & your Brain.",
		installable: true,
	},
	{
		id: "codex",
		name: "ChatGPT · Codex (OpenAI)",
		subtitle: "Uses your ChatGPT account (Plus/Pro or Free). Sign in directly in your browser.",
		installable: true,
	},
	{
		id: "agy",
		name: "Gemini · Antigravity (Google)",
		subtitle: "Uses your Google account for Gemini 4 Hydrogen/Argon & fast brain tasks.",
		installable: false,
	},
];

/** Live status + one-click install / browser sign-in for Claude, Codex, and Antigravity. */
export function ProviderSetupList({
	onConnected,
}: {
	readonly onConnected?: () => void;
}): React.JSX.Element {
	const toast = useUi((s) => s.toast);
	const [providers, setProviders] = useState<ProviderState[]>([]);
	const [extras, setExtras] = useState<ExtrasStatus | null>(null);
	const [checking, setChecking] = useState<boolean>(false);
	const [busyId, setBusyId] = useState<ProviderId | "ecc" | "feed" | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setChecking(true);
		try {
			const [nextProviders, nextExtras] = await Promise.all([
				window.teez.agents.setupStatus(),
				window.teez.agents.extrasStatus(),
			]);
			setProviders(nextProviders);
			setExtras(nextExtras);
		} finally {
			setChecking(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const handleInstall = async (id: ProviderId): Promise<void> => {
		setBusyId(id);
		setError(null);
		try {
			const res = await window.teez.agents.install(id);
			if (!res.ok) {
				setError(res.error ?? "Install failed.");
			} else if (id === "agy") {
				toast("Opened antigravity.google — install it, then click Refresh.", "info");
			} else {
				toast("Installed! Now click Sign in with Browser.", "success");
			}
			await refresh();
		} finally {
			setBusyId(null);
		}
	};

	const handleLogin = async (id: ProviderId): Promise<void> => {
		setBusyId(id);
		setError(null);
		try {
			const res = await window.teez.agents.login(id);
			if (res.ok) {
				toast("Connected!", "success");
				onConnected?.();
			} else {
				setError(res.error ?? "Sign-in did not complete.");
			}
			await refresh();
		} finally {
			setBusyId(null);
		}
	};

	const handleInstallEcc = async (): Promise<void> => {
		setBusyId("ecc");
		setError(null);
		try {
			const res = await window.teez.agents.installEcc();
			if (res.ok) toast("ECC (Everything Claude Code) installed!", "success");
			else setError(res.error ?? "ECC install failed.");
			await refresh();
		} finally {
			setBusyId(null);
		}
	};

	const handleInstallFeedTools = async (): Promise<void> => {
		setBusyId("feed");
		setError(null);
		try {
			const res = await window.teez.agents.installFeedTools();
			if (res.ok) toast("Video tools installed for Feed the Brain!", "success");
			else setError(res.error ?? "Video tools install failed.");
			await refresh();
		} finally {
			setBusyId(null);
		}
	};

	const feedTools = extras?.feedTools;
	const feedReady = Boolean(feedTools?.watchScript && feedTools.python && feedTools.ytdlp && feedTools.ffmpeg);

	return (
		<div className="space-y-3">
			<div className="flex justify-end">
				<button
					type="button"
					disabled={checking || busyId !== null}
					onClick={() => void refresh()}
					className="cut-corner flex items-center gap-1.5 border border-border bg-surface px-3 py-1.5 font-condensed text-xs uppercase tracking-wider text-muted hover:border-red/50 hover:text-text disabled:opacity-50"
				>
					<RefreshCw size={12} className={checking ? "animate-spin" : ""} />
					<span>Refresh</span>
				</button>
			</div>

			{AI_PROVIDERS.map((meta) => {
				const state = providers.find((p) => p.id === meta.id);
				const busyThis = busyId === meta.id;
				const ready = Boolean(state?.installed && state?.loggedIn);
				const handleInstallEcc = async (): Promise<void> => {
		setBusyId("ecc");
		setError(null);
		try {
			const res = await window.teez.agents.installEcc();
			if (res.ok) toast("ECC (Everything Claude Code) installed!", "success");
			else setError(res.error ?? "ECC install failed.");
			await refresh();
		} finally {
			setBusyId(null);
		}
	};

	const handleInstallFeedTools = async (): Promise<void> => {
		setBusyId("feed");
		setError(null);
		try {
			const res = await window.teez.agents.installFeedTools();
			if (res.ok) toast("Video tools installed for Feed the Brain!", "success");
			else setError(res.error ?? "Video tools install failed.");
			await refresh();
		} finally {
			setBusyId(null);
		}
	};

	const feedTools = extras?.feedTools;
	const feedReady = Boolean(feedTools?.watchScript && feedTools.python && feedTools.ytdlp && feedTools.ffmpeg);

	return (
					<div
						key={meta.id}
						className={`cut-corner flex flex-wrap items-center justify-between gap-4 border p-4 ${
							ready ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-surface"
						}`}
					>
						<div className="min-w-0 flex-1 space-y-1">
							<div className="flex items-center gap-2">
								<span className="font-condensed text-base font-semibold uppercase tracking-wider text-text">
									{meta.name}
								</span>
								{checking && !state ? (
									<span className="font-mono text-[10px] text-muted">Checking…</span>
								) : ready ? (
									<span className="flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
										<Check size={11} />
										Ready{state?.detail ? ` · ${state.detail}` : ""}
									</span>
								) : state?.installed ? (
									<span className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] text-amber-300">
										Needs sign-in{state.detail ? ` · ${state.detail}` : ""}
									</span>
								) : (
									<span className="rounded bg-bg px-2 py-0.5 font-mono text-[10px] text-muted">
										Not installed
									</span>
								)}
							</div>
							<p className="font-mono text-[11px] text-muted">{meta.subtitle}</p>
						</div>

						<div className="flex items-center gap-2">
							{!state?.installed ? (
								<button
									type="button"
									disabled={busyId !== null}
									onClick={() => void handleInstall(meta.id)}
									className="cut-corner btn-hot flex items-center gap-1.5 px-3.5 py-1.5 font-condensed text-xs uppercase tracking-wider text-white disabled:opacity-50"
								>
									{meta.installable ? <Download size={13} /> : <ExternalLink size={13} />}
									<span>{busyThis ? "Installing…" : meta.installable ? "One-Click Install" : "Download"}</span>
								</button>
							) : !state.loggedIn ? (
								<button
									type="button"
									disabled={busyId !== null}
									onClick={() => void handleLogin(meta.id)}
									className="cut-corner btn-hot flex items-center gap-1.5 px-3.5 py-1.5 font-condensed text-xs uppercase tracking-wider text-white disabled:opacity-50"
								>
									<ExternalLink size={13} />
									<span>{busyThis ? "Waiting for browser…" : "Sign in with Browser"}</span>
								</button>
							) : null}
						</div>
					</div>
				);
			})}

			<div className="pt-2">
				<p className="mb-2 font-condensed text-xs uppercase tracking-wider text-muted">
					Optional Add-Ons
				</p>
				<div className="space-y-3">
					<div
						className={`cut-corner flex flex-wrap items-center justify-between gap-4 border p-4 ${
							extras?.ecc.installed ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-surface"
						}`}
					>
						<div className="min-w-0 flex-1 space-y-1">
							<div className="flex items-center gap-2">
								<span className="font-condensed text-base font-semibold uppercase tracking-wider text-text">
									Everything Claude Code (ECC)
								</span>
								{extras?.ecc.installed ? (
									<span className="flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
										<Check size={11} />
										Installed
									</span>
								) : (
									<span className="rounded bg-bg px-2 py-0.5 font-mono text-[10px] text-muted">
										Optional
									</span>
								)}
							</div>
							<p className="font-mono text-[11px] text-muted">
								Adds extra coding agents, TDD workflows, and review skills for Claude Code.
							</p>
						</div>
						{!extras?.ecc.installed ? (
							<button
								type="button"
								disabled={busyId !== null}
								onClick={() => void handleInstallEcc()}
								className="cut-corner btn-hot flex items-center gap-1.5 px-3.5 py-1.5 font-condensed text-xs uppercase tracking-wider text-white disabled:opacity-50"
							>
								<Download size={13} />
								<span>{busyId === "ecc" ? "Installing ECC…" : "One-Click Install"}</span>
							</button>
						) : null}
					</div>

					<div
						className={`cut-corner flex flex-wrap items-center justify-between gap-4 border p-4 ${
							feedReady ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-surface"
						}`}
					>
						<div className="min-w-0 flex-1 space-y-1">
							<div className="flex items-center gap-2">
								<span className="font-condensed text-base font-semibold uppercase tracking-wider text-text">
									Feed Video Tools (/watch)
								</span>
								{feedReady ? (
									<span className="flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] text-emerald-400">
										<Check size={11} />
										Ready
									</span>
								) : (
									<span className="rounded bg-bg px-2 py-0.5 font-mono text-[10px] text-muted">
										{feedTools
											? [
													!feedTools.python && "Python",
													!feedTools.ytdlp && "yt-dlp",
													!feedTools.ffmpeg && "ffmpeg",
												]
													.filter(Boolean)
													.join(", ") || "Checking…"
											: "Checking…"}
									</span>
								)}
							</div>
							<p className="font-mono text-[11px] text-muted">
								Lets Feed the Brain download and transcribe YouTube, Instagram, and TikTok videos (`watch.py` is bundled).
							</p>
						</div>
						{!feedReady ? (
							<button
								type="button"
								disabled={busyId !== null}
								onClick={() => void handleInstallFeedTools()}
								className="cut-corner btn-hot flex items-center gap-1.5 px-3.5 py-1.5 font-condensed text-xs uppercase tracking-wider text-white disabled:opacity-50"
							>
								<Download size={13} />
								<span>{busyId === "feed" ? "Installing tools…" : "One-Click Install"}</span>
							</button>
						) : null}
					</div>
				</div>
			</div>

			{error ? (
				<div className="cut-corner border border-red-hot/50 bg-red/10 px-4 py-2.5 font-mono text-xs text-red-hot">
					{error}
				</div>
			) : null}
		</div>
	);
}
