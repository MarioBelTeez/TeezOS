import path from "node:path";
import { look } from "../../../src/main/proxmox/look.ts";
import { buildOverview } from "../../../src/main/proxmox/overview.ts";
import { AlertWatcher } from "./alerts.ts";
import { checkConfig, loadConfig, validateConfig } from "./config.ts";
import { GitSync } from "./git-sync.ts";
import { createPhoneServer, type Route } from "./http.ts";
import { listenPhone, shutdownPhone } from "./listen.ts";
import { pushReplies } from "./chat/reply-push.ts";
import { createChatService } from "./chat/setup.ts";
import { createCaptures } from "./routes/captures.ts";
import { createChatsRoute } from "./routes/chats.ts";
import { createFeedRoute } from "./feed-setup.ts";
import { RunsWatcher } from "./runs-watcher.ts";
import { loadRunnerClient } from "./runner-client.ts";
import { PushService, loadVapid } from "./push.ts";
import { createPushRoute } from "./routes/push.ts";
import { createRunsRoute } from "./routes/runs.ts";
import { createServerRoute, loadProxmoxClient } from "./routes/server.ts";

const RETRY_INTERVAL_MS = 120_000;
const SERVER_CHECK_MS = 300_000;
const RUNS_CHECK_MS = 30_000;
/** Identifies this service to the push services (an https subject, not a personal email). */
const VAPID_SUBJECT = process.env["TEEZ_PHONE_PUBLIC_URL"] || "https://teez-phone.invalid";

// `--check-config`: validate the environment and exit, without starting anything (deploy check).
if (process.argv.includes("--check-config")) {
	const result = checkConfig(process.env);
	(result.ok ? console.log : console.error)(result.text);
	process.exit(result.ok ? 0 : 1);
}

const config = loadConfig(process.env);
const problems = validateConfig(config);
if (problems.length > 0) {
	for (const problem of problems) console.error(`phone: ${problem}`);
	process.exit(1);
}
const sync = new GitSync({ vault: config.vaultDir });
const captures = createCaptures({ vault: config.vaultDir, dataDir: config.dataDir, sync, now: Date.now });

// The chat saves through this same captures instance: one log, one retry loop.
// Chats read the service's clone; GitSync (serialised) keeps it fresh.
const chats = createChatService(config, captures.saveCapture, () => sync.pull());

// Web Push needs vapid.json; without it the push routes answer 503 and nothing is sent.
const vapid = loadVapid(path.join(config.secretsDir, "vapid.json"), VAPID_SUBJECT);
const push = vapid ? new PushService({ file: path.join(config.dataDir, "push.json"), vapid }) : null;
// No push for a reply the user is already watching (the chat is open on the phone).
if (push) pushReplies(chats.service, (payload) => push.notify(payload));

// Server monitoring needs proxmox.json; it is read again on each request until it exists.
const firstClient = loadProxmoxClient(config.secretsDir);
let proxmox = firstClient;
const proxmoxClient = () => (proxmox ??= loadProxmoxClient(config.secretsDir));
// The background watch starts only when both Proxmox and push are set up at launch.
const alerts = push && firstClient ? new AlertWatcher({ look: (since) => look(firstClient, Date.now, since), push, intervalMs: SERVER_CHECK_MS }) : null;
alerts?.start();

// Automations need runner-token and the runner certificate; without them the runs routes answer 503.
const runner = loadRunnerClient(config.secretsDir, config.runnerUrl, config.runnerCert);
const startedByPhone = new Set<string>();
const runsWatcher = push && runner ? new RunsWatcher({ client: runner, push, intervalMs: RUNS_CHECK_MS, startedByPhone }) : null;
runsWatcher?.start();

const routes: readonly Route[] = [
	captures.route,
	createChatsRoute({ service: chats.service, saveCapture: captures.saveCapture, claudeEnabled: chats.claudeEnabled }),
	createFeedRoute(config, sync),
	createServerRoute({ api: proxmoxClient, look: (api) => look(api), overview: (api) => buildOverview(api) }),
	createPushRoute({ push, publicKey: vapid?.publicKey ?? "" }),
	createRunsRoute({ client: runner, startedByPhone }),
];

const report = (error: unknown): void => console.error("phone: capture retry failed", error);

await sync.refresh();
captures.recover().catch(report);
const pullFailed = (error: unknown): void => console.error("phone: vault pull failed", error);
const retryTimer = setInterval(() => {
	captures.retry().catch(report);
	sync
		.pull()
		.then((ok) => {
			if (!ok) pullFailed(sync.state().lastError);
		})
		.catch(pullFailed);
}, RETRY_INTERVAL_MS).unref();

const server = createPhoneServer(config, routes);

try {
	console.log(`teez-phone listening on ${await listenPhone(server, config)}`);
} catch (error) {
	console.error("phone: could not listen", error);
	process.exit(1);
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		shutdownPhone(server, {
			stop: () => {
				alerts?.stop();
				runsWatcher?.stop();
				clearInterval(retryTimer);
				chats.stop();
			},
			idle: () => sync.idle(),
			exit: (code) => process.exit(code),
		});
	});
}
