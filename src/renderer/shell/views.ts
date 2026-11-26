import { Code2, Brain, Sparkles, Network, Globe, PenTool, Server, Timer, type LucideIcon } from "lucide-react";
import type { ViewId } from "../../shared/views.ts";

export const VIEW_META: Record<ViewId, { readonly label: string; readonly icon: LucideIcon; readonly key: string }> = {
	code: { label: "Code", icon: Code2, key: "Ctrl+1" },
	brain: { label: "Brain — the vault", icon: Brain, key: "Ctrl+2" },
	feed: { label: "Feed the Brain", icon: Sparkles, key: "Ctrl+3" },
	agents: { label: "Agents", icon: Network, key: "Ctrl+4" },
	browser: { label: "Browser", icon: Globe, key: "Ctrl+5" },
	canvas: { label: "Canvas — Sketchpad & Viewer", icon: PenTool, key: "Ctrl+6" },
	server: { label: "Server — Proxmox", icon: Server, key: "Ctrl+7" },
	automations: { label: "Automations", icon: Timer, key: "Ctrl+8" },
};
