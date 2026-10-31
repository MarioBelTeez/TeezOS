import { describe, expect, test } from "vitest";
import { diffAlerts, type Snapshot } from "./watch.ts";

const healthy: Snapshot = {
	at: 1000,
	reachable: true,
	ups: { status: "OL", charge: 100, runtimeSeconds: 3000, load: 10, inputVoltage: 230, batteryVoltage: 27, model: "x" },
	guests: [
		{ vmid: 102, name: "adguard", status: "running" },
		{ vmid: 103, name: "docker", status: "running" },
	],
	zfs: [{ name: "tank", health: "ONLINE" }],
	disks: [{ name: "root", used: 5, total: 100 }],
	tasks: [],
};
const titles = (previous: Snapshot | null, current: Snapshot): string[] => diffAlerts(previous, current).map((a) => a.title);

describe("diffAlerts", () => {
	test("a healthy server, first look or later, is quiet", () => {
		expect(diffAlerts(null, healthy)).toEqual([]);
		expect(diffAlerts(healthy, { ...healthy, at: 1300 })).toEqual([]);
	});

	test("power cut, low battery, and power back", () => {
		const onBattery = { ...healthy, ups: { ...healthy.ups!, status: "OB DISCHRG", charge: 80 } };
		expect(titles(healthy, onBattery)).toEqual(["Server on battery"]);
		expect(titles(onBattery, { ...onBattery, at: 1300 })).toEqual([]);
		const low = { ...onBattery, ups: { ...onBattery.ups!, status: "OB DISCHRG LB", charge: 18 } };
		expect(titles(onBattery, low)).toEqual(["Server battery low"]);
		expect(titles(low, healthy)).toEqual(["Power is back"]);
	});

	test("a battery already running at the first look is reported", () => {
		expect(titles(null, { ...healthy, ups: { ...healthy.ups!, status: "OB" } })).toEqual(["Server on battery"]);
	});

	test("a guest that stops is reported; one already stopped at the first look is not", () => {
		const stopped = { ...healthy, guests: [{ vmid: 102, name: "adguard", status: "stopped" }, healthy.guests[1]!] };
		expect(diffAlerts(healthy, stopped)).toEqual([{ key: "guest-102", title: "adguard stopped", body: "Guest 102 was running at the last check and is now stopped." }]);
		expect(diffAlerts(null, stopped)).toEqual([]);
	});

	test("a pool that is not ONLINE and a disk past 90 % are reported once", () => {
		const bad = { ...healthy, zfs: [{ name: "tank", health: "DEGRADED" }], disks: [{ name: "root", used: 93, total: 100 }] };
		expect(titles(healthy, bad)).toEqual(["ZFS pool tank is DEGRADED", "root is 93 % full"]);
		expect(titles(bad, { ...bad, at: 1300 })).toEqual([]);
	});

	test("a failed or warning backup since the last look is reported, older ones are not", () => {
		const tasks = [
			{ upid: "a", type: "vzdump", status: "job errors", starttime: 1100, endtime: 1200, user: "root@pam" },
			{ upid: "b", type: "vzdump", status: "WARNINGS: 1", starttime: 1100, endtime: 1250, user: "root@pam" },
			{ upid: "c", type: "vzdump", status: "OK", starttime: 1100, endtime: 1250, user: "root@pam" },
			{ upid: "d", type: "vzdump", status: "job errors", starttime: 500, endtime: 900, user: "root@pam" },
		];
		expect(titles(healthy, { ...healthy, at: 1300, tasks })).toEqual(["Backup failed", "Backup finished with warnings"]);
		expect(titles(null, { ...healthy, at: 1300, tasks })).toEqual([]);
	});

	test("the server going silent, and coming back", () => {
		const down: Snapshot = { ...healthy, reachable: false, ups: null, guests: [], zfs: [], disks: [], tasks: [] };
		expect(titles(healthy, down)).toEqual(["Proxmox is not answering"]);
		expect(titles(down, { ...down, at: 1300 })).toEqual([]);
		// While it is silent nothing else is judged; when it answers again, only what is wrong now is reported.
		expect(titles(down, healthy)).toEqual(["Proxmox is answering again"]);
	});
});
