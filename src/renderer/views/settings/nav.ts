import type { ModuleId } from "../../../shared/modules.ts";

/** The sections of Settings, in the order the left list shows them. */

export const SETTINGS_PAGES = [
	"general",
	"chat",
	"editor",
	"terminal",
	"brain",
	"feed",
	"browser",
	"agents",
	"server",
	"automations",
	"discord",
	"presets",
	"projects",
	"updates",
	"about",
] as const;

export type SettingsPageId = (typeof SETTINGS_PAGES)[number];

export const SETTINGS_LABEL: Readonly<Record<SettingsPageId, string>> = {
	general: "General",
	chat: "Chat",
	editor: "Editor",
	terminal: "Terminal",
	brain: "Brain",
	feed: "Feed",
	browser: "Browser",
	agents: "Agents",
	server: "Server",
	automations: "Automations",
	discord: "Discord",
	presets: "Presets",
	projects: "Projects",
	updates: "Updates",
	about: "About",
};

/** The pages that are a module's: their dot in the list shows whether it is on. */
export const PAGE_MODULE: Readonly<Partial<Record<SettingsPageId, ModuleId>>> = {
	terminal: "terminal",
	brain: "brain",
	feed: "feed",
	browser: "browser",
	agents: "agents",
	server: "server",
	automations: "automations",
};

export const isSettingsPage = (value: string): value is SettingsPageId => (SETTINGS_PAGES as readonly string[]).includes(value);
