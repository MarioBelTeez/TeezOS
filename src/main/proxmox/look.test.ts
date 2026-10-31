import { describe, expect, it } from "vitest";
import { look, type LookApi } from "./look.ts";

const NOW_MS = 1_700_000_000_000;

type Call = { path: string; params?: Record<string, string | number> | undefined };

function fakeApi(fail: (path: string) => boolean = () => false): { api: LookApi; calls: Call[] } {
	const calls: Call[] = [];
	const answers: Record<string, unknown> = {
		"/nodes/pve/status": { rootfs: { used: 10, total: 100 } },
		"/nodes/pve/lxc": [{ vmid: "100", name: "adguard", status: "running" }],
		"/nodes/pve/qemu": [{ vmid: 200, name: "vm", status: "stopped" }],
		"/nodes/pve/storage": [
			{ storage: "local", active: 1, total: 50, used: 5 },
			{ storage: "tank", active: 1, total: 1000, used: 400 },
			{ storage: "off", active: 0, total: 10, used: 1 },
		],
		"/nodes/pve/disks/zfs": [{ name: "tank", health: "ONLINE" }],
		"/nodes/pve/tasks": [{ upid: "u1", type: "vzdump", starttime: 1, user: "root@pam" }],
	};
	const api = {
		node: "pve",
		host: "127.0.0.1",
		request: (async (_method: string, path: string, params?: Record<string, string | number>) => {
			calls.push({ path, params });
			if (fail(path) || !(path in answers)) throw new Error(`no answer for ${path}`);
			return answers[path];
		}) as LookApi["request"],
	};
	return { api, calls };
}

describe("look", () => {
	it("builds the snapshot from a fake client", async () => {
		const { api } = fakeApi();
		const snap = await look(api, () => NOW_MS);
		expect(snap.at).toBe(1_700_000_000);
		expect(snap.reachable).toBe(true);
		expect(snap.guests).toEqual([
			{ vmid: 100, name: "adguard", status: "running" },
			{ vmid: 200, name: "vm", status: "stopped" },
		]);
		expect(snap.zfs).toEqual([{ name: "tank", health: "ONLINE" }]);
		expect(snap.disks).toEqual([
			{ name: "Root disk", used: 10, total: 100 },
			{ name: "tank", used: 400, total: 1000 },
		]);
		expect(snap.tasks).toHaveLength(1);
	});

	it("asks for backup tasks since the previous look, or the last hour on a first look", async () => {
		const first = fakeApi();
		await look(first.api, () => NOW_MS);
		expect(first.calls.find((c) => c.path.endsWith("/tasks"))?.params).toMatchObject({ since: 1_700_000_000 - 3600, typefilter: "vzdump" });
		const next = fakeApi();
		await look(next.api, () => NOW_MS, 1_699_999_000);
		expect(next.calls.find((c) => c.path.endsWith("/tasks"))?.params?.["since"]).toBe(1_699_999_000);
	});

	it("falls back to empty parts but throws when the node status fails", async () => {
		const partial = await look(fakeApi((p) => p.endsWith("/lxc")).api, () => NOW_MS);
		expect(partial.guests.map((g) => g.vmid)).toEqual([200]);
		await expect(look(fakeApi((p) => p.endsWith("/status")).api, () => NOW_MS)).rejects.toThrow("no answer");
	});
});
