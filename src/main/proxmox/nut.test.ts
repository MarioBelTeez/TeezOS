import { describe, expect, test } from "vitest";
import { createServer } from "node:net";
import { parseNutVars, readUps, toUpsStatus } from "./nut.ts";

const SAMPLE = [
	"BEGIN LIST VAR ups",
	'VAR ups battery.charge "100"',
	'VAR ups battery.voltage "27.10"',
	'VAR ups input.voltage "237.2"',
	'VAR ups ups.load "1"',
	'VAR ups ups.status "OL"',
	'VAR ups device.mfr "MEC"',
	"END LIST VAR ups",
	"",
].join("\n");

describe("NUT", () => {
	test("parses LIST VAR output", () => {
		const status = toUpsStatus(parseNutVars(SAMPLE));
		expect(status).toEqual({
			status: "OL",
			charge: 100,
			runtimeSeconds: null,
			load: 1,
			inputVoltage: 237.2,
			batteryVoltage: 27.1,
			model: "MEC",
		});
	});

	test("talks to a upsd over TCP", async () => {
		const server = createServer((socket) => {
			socket.on("data", (data) => {
				if (String(data).startsWith("LIST VAR ups")) socket.write(SAMPLE);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		try {
			const status = await readUps("127.0.0.1", "ups", port);
			expect(status?.status).toBe("OL");
			expect(status?.charge).toBe(100);
		} finally {
			server.close();
		}
	});

	test("an unreachable upsd is null, not a throw", async () => {
		expect(await readUps("127.0.0.1", "ups", 1, 500)).toBeNull();
	});
});
