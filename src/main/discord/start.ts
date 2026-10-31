import { app } from "electron";
import type { SettingsStore } from "../settings/store.ts";
import { DiscordIpc, pipeCandidates } from "./ipc.ts";
import { PresenceTracker, buildActivity } from "./presence.ts";
import { PresenceService } from "./service.ts";

/** The "TeezAI" application on discord.com/developers. An id, not a secret. */
export const DISCORD_CLIENT_ID = "1505397605872435270";

export type Presence = {
	readonly tracker: PresenceTracker;
	readonly changed: () => void;
	readonly stop: () => void;
};

/** Discord's status for TeezAI: on from launch, following the setting and the chats. */
export function startPresence(store: SettingsStore): Presence {
	const tracker = new PresenceTracker();
	const startedAt = Date.now();
	const service = new PresenceService(
		() => new DiscordIpc(DISCORD_CLIENT_ID, pipeCandidates(process.platform, process.env)),
		() => {
			const settings = store.get();
			const active = settings.workspaces.find((w) => w.id === settings.activeWorkspaceId);
			return buildActivity(tracker.snapshot(), {
				mode: settings.agent.presence,
				activeWorkspace: active?.name ?? null,
				version: app.getVersion(),
				startedAt,
			});
		},
	);
	const unsubscribe = store.onChange(() => service.refresh());
	service.refresh();
	return {
		tracker,
		changed: () => service.refresh(),
		stop: () => {
			unsubscribe();
			service.stop();
		},
	};
}
