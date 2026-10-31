import { useSettings } from "../state/settings.ts";
import { useUi } from "../state/ui.ts";
import { PAGE_MODULE, SETTINGS_LABEL, SETTINGS_PAGES, type SettingsPageId } from "./settings/nav.ts";
import { GeneralPage } from "./settings/GeneralPage.tsx";
import { ChatPage } from "./settings/ChatPage.tsx";
import { EditorPage } from "./settings/EditorPage.tsx";
import { TerminalPage } from "./settings/TerminalPage.tsx";
import { BrainPage } from "./settings/BrainPage.tsx";
import { FeedPage } from "./settings/FeedPage.tsx";
import { BrowserPage } from "./settings/BrowserPage.tsx";
import { AgentsPage, AutomationsPage, DiscordPage, ServerPage } from "./settings/ModulesPage.tsx";
import { PresetsPage } from "./settings/PresetsPage.tsx";
import { ProjectsPage } from "./settings/ProjectsPage.tsx";
import { UpdatesPage } from "./settings/UpdatesPage.tsx";
import { AboutPage } from "./settings/AboutPage.tsx";

const PAGES: Readonly<Record<SettingsPageId, () => React.JSX.Element | null>> = {
	general: GeneralPage,
	chat: ChatPage,
	editor: EditorPage,
	terminal: TerminalPage,
	brain: BrainPage,
	feed: FeedPage,
	browser: BrowserPage,
	agents: AgentsPage,
	server: ServerPage,
	automations: AutomationsPage,
	discord: DiscordPage,
	presets: PresetsPage,
	projects: ProjectsPage,
	updates: UpdatesPage,
	about: AboutPage,
};

/** Settings: the sections down the left, the open one on the right. A module's dot is lit while it is on. */
export function SettingsView(): React.JSX.Element {
	const ready = useSettings((s) => s.settings !== null);
	const modules = useSettings((s) => s.settings?.modules);
	const page = useUi((s) => s.settingsPage);
	const openSettings = useUi((s) => s.openSettings);
	if (!ready) return <div className="flex-1" />;
	const Page = PAGES[page];

	return (
		<div className="flex min-h-0 flex-1">
			<nav aria-label="Settings sections" className="glass flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border px-3 py-6">
				<p className="glow-text px-2 font-condensed text-xs uppercase tracking-[0.3em] text-red-hot">TeezOS</p>
				<h1 className="mb-4 px-2 font-display text-4xl tracking-wide [text-shadow:0_0_28px_rgb(232_0_45/0.25)]">SETTINGS</h1>
				{SETTINGS_PAGES.map((id) => {
					const active = id === page;
					const module = PAGE_MODULE[id];
					const on = module && modules ? modules[module].enabled : null;
					return (
						<button
							key={id}
							type="button"
							aria-current={active ? "page" : undefined}
							onClick={() => openSettings(id)}
							className={`relative flex items-center gap-2 px-3 py-1.5 text-left font-condensed text-[13px] uppercase tracking-wider transition-colors ${
								active ? "tab-active bg-surface-2 text-text" : "text-muted hover:text-text"
							}`}
						>
							{active ? <span className="absolute -left-1 top-1.5 bottom-1.5 w-[3px] -skew-y-12 bg-red-hot shadow-[0_0_10px_var(--color-glow)]" /> : null}
							<span className="flex-1">{SETTINGS_LABEL[id]}</span>
							{on === null ? null : <span title={on ? "on" : "off"} className={`h-1.5 w-1.5 ${on ? "bg-red-hot shadow-[0_0_6px_var(--color-glow)]" : "bg-border"}`} />}
						</button>
					);
				})}
			</nav>
			<div className="min-h-0 flex-1 overflow-y-auto px-10 py-8">
				{/* Pages are one 3xl column; on a wide window it moves to the middle rather than hugging the nav. */}
				<div className="w-full max-w-3xl 2xl:mx-auto">
					<p className="font-condensed text-xs uppercase tracking-[0.3em] text-muted">Settings</p>
					<h2 className="glow-text mb-4 font-display text-5xl leading-none tracking-wide">{SETTINGS_LABEL[page].toUpperCase()}</h2>
					<Page />
				</div>
			</div>
		</div>
	);
}
