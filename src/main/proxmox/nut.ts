import { connect } from "node:net";

/**
 * The UPS, read straight from NUT's network server (upsd, port 3493) — the
 * same numbers `upsc ups@localhost` prints on the host. Read-only: LIST VAR
 * needs no login. One connection per read, closed at once.
 */

export type UpsStatus = {
	readonly status: string;
	readonly charge: number | null;
	readonly runtimeSeconds: number | null;
	readonly load: number | null;
	readonly inputVoltage: number | null;
	readonly batteryVoltage: number | null;
	readonly model: string;
};

export function parseNutVars(text: string): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const match = /^VAR \S+ (\S+) "(.*)"$/.exec(line.trim());
		if (match?.[1]) vars[match[1]] = match[2] ?? "";
	}
	return vars;
}

const number = (value: string | undefined): number | null => {
	if (value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

export function toUpsStatus(vars: Record<string, string>): UpsStatus {
	return {
		status: vars["ups.status"] ?? "unknown",
		charge: number(vars["battery.charge"]),
		runtimeSeconds: number(vars["battery.runtime"]),
		load: number(vars["ups.load"]),
		inputVoltage: number(vars["input.voltage"]),
		batteryVoltage: number(vars["battery.voltage"]),
		model: [vars["device.mfr"], vars["device.model"] ?? vars["ups.model"]].filter(Boolean).join(" "),
	};
}

export function readUps(host: string, upsName = "ups", port = 3493, timeoutMs = 4000): Promise<UpsStatus | null> {
	return new Promise((resolve) => {
		let buffer = "";
		let settled = false;
		const finish = (value: UpsStatus | null): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		const socket = connect({ host, port, timeout: timeoutMs }, () => {
			socket.write(`LIST VAR ${upsName}\n`);
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.includes(`END LIST VAR ${upsName}`)) {
				socket.write("LOGOUT\n");
				finish(toUpsStatus(parseNutVars(buffer)));
			} else if (/^ERR /m.test(buffer)) {
				finish(null);
			}
		});
		socket.on("timeout", () => finish(null));
		socket.on("error", () => finish(null));
		socket.on("close", () => finish(buffer.includes("VAR ") ? toUpsStatus(parseNutVars(buffer)) : null));
	});
}
