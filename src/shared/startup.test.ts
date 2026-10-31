import { describe, expect, test } from "vitest";
import { startupDesk } from "./startup.ts";

const ws = [
	{ id: "t", name: "TeezMind", path: "C:\\Users\\user\\TeezMind" },
	{ id: "a", name: "teezai", path: "C:\\Users\\user\\Projects\\teezai" },
];
const desk = (id: string, workspaceId: string) => ({ id, name: "", workspaceId, grid: null });

describe("startupDesk", () => {
	test("already on TeezMind: keep", () => {
		expect(startupDesk({ desks: [desk("d1", "t")], activeDeskId: "d1", workspaces: ws, vaultPath: null })).toEqual({ kind: "keep" });
	});
	test("another desk shows TeezMind: switch to it", () => {
		expect(startupDesk({ desks: [desk("d1", "a"), desk("d2", "t")], activeDeskId: "d1", workspaces: ws, vaultPath: null })).toEqual({ kind: "switch", deskId: "d2" });
	});
	test("no TeezMind desk: create one", () => {
		expect(startupDesk({ desks: [desk("d1", "a")], activeDeskId: "d1", workspaces: ws, vaultPath: null })).toEqual({ kind: "create", workspaceId: "t" });
	});
	test("the vault path wins over the name", () => {
		const renamed = [{ id: "v", name: "brain", path: "c:\\users\\user\\teezmind" }, ...ws.slice(1)];
		expect(startupDesk({ desks: [desk("d1", "a")], activeDeskId: "d1", workspaces: renamed, vaultPath: "C:\\Users\\user\\TeezMind" })).toEqual({ kind: "create", workspaceId: "v" });
	});
	test("no vault anywhere: keep", () => {
		expect(startupDesk({ desks: [desk("d1", "a")], activeDeskId: "d1", workspaces: ws.slice(1), vaultPath: null })).toEqual({ kind: "keep" });
	});
});
