import { postJson, request, type ApiResult } from "./api.ts";

/**
 * Web Push on the iPhone. iOS only offers it to an app added to the Home
 * Screen (16.4+), and only asks permission from a tap, so the app never asks
 * on its own: it shows an "Enable notifications" button and subscribes with
 * the server's VAPID key (`GET /api/push/key`) when the user taps it.
 */

export type PushState = "unsupported" | "needs-install" | "ask" | "denied" | "on";

/** A VAPID key in URL-safe base64, as the bytes PushManager wants. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
	const padded = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
	const raw = atob(padded);
	const out = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
	return out;
}

const standalone = (): boolean =>
	window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export async function pushState(): Promise<PushState> {
	if (!("serviceWorker" in navigator)) return "unsupported";
	if (!("PushManager" in window) || !("Notification" in window)) return standalone() ? "unsupported" : "needs-install";
	if (Notification.permission === "denied") return "denied";
	if (Notification.permission !== "granted") return "ask";
	const registration = await navigator.serviceWorker.getRegistration();
	const subscription = await registration?.pushManager.getSubscription();
	return subscription ? "on" : "ask";
}

const READY_TIMEOUT_MS = 10_000;

/** The task's result, or a rejection with `message` once `ms` have passed. */
export function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([task, late]).finally(() => clearTimeout(timer));
}

/** Must run from a tap: asks permission, subscribes, and hands the subscription to the server. */
export async function enablePush(): Promise<ApiResult<unknown>> {
	// Everything that can throw or hang is inside the try, so the button never sticks on "…".
	try {
		const permission = await Notification.requestPermission();
		if (permission !== "granted") return { ok: false, error: "Notifications were not allowed. Turn them on in Settings › Notifications › TeezOS.", offline: false };
		const key = await request<{ publicKey: string }>("/api/push/key");
		if (!key.ok) return key;
		const registration = await withTimeout(navigator.serviceWorker.ready, READY_TIMEOUT_MS, "The service worker is not ready. Reopen the app and try again.");
		const subscription =
			(await registration.pushManager.getSubscription()) ??
			(await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key.data.publicKey) }));
		return await postJson("/api/push/subscribe", subscription.toJSON());
	} catch (error) {
		return { ok: false, error: `Could not turn on notifications: ${error instanceof Error ? error.message : String(error)}`, offline: false };
	}
}

/** Stops pushes to this phone, here and on the server. */
export async function disablePush(): Promise<ApiResult<unknown>> {
	const registration = await navigator.serviceWorker.getRegistration();
	const subscription = await registration?.pushManager.getSubscription();
	if (!subscription) return { ok: true, data: {} };
	const result = await postJson("/api/push/subscribe", { endpoint: subscription.endpoint }, "DELETE");
	if (result.ok) await subscription.unsubscribe();
	return result;
}
