import { notificationFor, urlForClick } from "./sw-logic.ts";

/**
 * The service worker, built to /sw.js (same origin, as the CSP and the push
 * spec require). It handles only `push` and `notificationclick`: no fetch
 * handler, so nothing is cached and the API is always live.
 *
 * The project's lib is DOM, not WebWorker (the two clash), so the few
 * service-worker types used here are spelled out.
 */

type Extendable = Event & { waitUntil(task: Promise<unknown>): void };
type PushEvent = Extendable & { readonly data: { json(): unknown } | null };
type ClickEvent = Extendable & { readonly notification: Notification };
type WindowClient = { readonly url: string; focus(): Promise<unknown>; postMessage(message: unknown): void };
type Scope = {
	readonly registration: ServiceWorkerRegistration;
	readonly clients: {
		matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WindowClient[]>;
		openWindow(url: string): Promise<unknown>;
	};
	addEventListener(type: "push", listener: (event: PushEvent) => void): void;
	addEventListener(type: "notificationclick", listener: (event: ClickEvent) => void): void;
};

const scope = self as unknown as Scope;

function payloadOf(event: PushEvent): unknown {
	try {
		return event.data?.json() ?? null;
	} catch {
		return null;
	}
}

scope.addEventListener("push", (event) => {
	// iOS revokes push for a worker that receives one and shows nothing, so a bad payload still notifies.
	const shown = notificationFor(payloadOf(event)) ?? { title: "TeezOS", options: { body: "Something needs a look.", data: { url: "/" } } };
	event.waitUntil(scope.registration.showNotification(shown.title, shown.options));
});

scope.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = urlForClick(event.notification.data);
	event.waitUntil(
		scope.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
			const open = windows[0];
			if (!open) return scope.clients.openWindow(url);
			open.postMessage({ type: "open", url });
			return open.focus();
		}),
	);
});
