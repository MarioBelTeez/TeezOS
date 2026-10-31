import { Code2, Brain, Sparkles, Network, Globe, Server, Timer, type LucideIcon } from "lucide-react";
import type { ViewId } from "../../shared/views.ts";

export const VIEW_META: Record<ViewId, { readonly label: string; readonly icon: LucideIcon; readonly key: string }> = {
	code: { label: "Code", icon: Code2, key: "Ctrl+1" },
	brain: { label: "Brain — the vault", icon: Brain, key: "Ctrl+2" },
	feed: { label: "Feed the Brain", icon: Sparkles, key: "Ctrl+3" },
	agents: { label: "Agents", icon: Network, key: "Ctrl+4" },
	browser: { label: "Browser", icon: Globe, key: "Ctrl+5" },
	server: { label: "Server — Proxmox", icon: Server, key: "Ctrl+6" },
	automations: { label: "Automations", icon: Timer, key: "Ctrl+7" },
};
