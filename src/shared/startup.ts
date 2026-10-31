import type { Desk } from "./desks.ts";

export type StartupInput = {
	readonly desks: readonly Desk[];
	readonly activeDeskId: string;
	readonly workspaces: readonly { readonly id: string; readonly name: string; readonly path: string }[];
	readonly vaultPath: string | null;
};

export type StartupResult =
	| { readonly kind: "keep" }
	| { readonly kind: "switch"; readonly deskId: string }
	| { readonly kind: "create"; readonly workspaceId: string };

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function startupDesk(input: StartupInput): StartupResult {
	const { desks, activeDeskId, workspaces, vaultPath } = input;
	const teezMind =
		(vaultPath ? workspaces.find((w) => norm(w.path) === norm(vaultPath)) : undefined) ??
		workspaces.find((w) => w.name.toLowerCase() === "teezmind");

	if (!teezMind) return { kind: "keep" };

	const activeDesk = desks.find((d) => d.id === activeDeskId);
	if (activeDesk?.workspaceId === teezMind.id) return { kind: "keep" };

	const existing = desks.find((d) => d.workspaceId === teezMind.id);
	if (existing) return { kind: "switch", deskId: existing.id };

	return { kind: "create", workspaceId: teezMind.id };
}
