import { useEffect, useState, type ReactNode } from "react";
import { enablePush, pushState, type PushState } from "../push.ts";

/**
 * "Enable notifications": iOS only asks from a tap, so this never asks on its
 * own. Hidden once push is on, refused, unsupported, or dismissed.
 */

const DISMISSED = "teez-push-dismissed";

export function PushBanner(): ReactNode {
	const [state, setState] = useState<PushState | null>(null);
	const [dismissed, setDismissed] = useState(() => {
		try {
			return localStorage.getItem(DISMISSED) === "1";
		} catch {
			return false;
		}
	});
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		void pushState()
			.then(setState)
			.catch(() => setState("unsupported"));
	}, []);

	if (dismissed || (state !== "ask" && state !== "needs-install")) return null;

	const dismiss = (): void => {
		setDismissed(true);
		try {
			localStorage.setItem(DISMISSED, "1");
		} catch {
			// Not remembered: it shows again next launch.
		}
	};

	const enable = async (): Promise<void> => {
		setBusy(true);
		const result = await enablePush();
		setBusy(false);
		if (result.ok) setState("on");
		else setError(result.error);
	};

	return (
		<div className="push-banner safe-x glass flex flex-wrap items-center gap-2 border-t border-red/50 py-2">
			<p className="min-w-48 flex-1 text-[15px]">{error ?? (state === "needs-install" ? "Add TeezOS to your Home Screen to get notifications." : "Get a notification when a reply, a run or an alert comes in.")}</p>
			{state === "ask" ? (
				<button type="button" disabled={busy} onClick={() => void enable()} className="btn-hot h-11 px-3 font-display text-[17px] tracking-wider">
					{busy ? "…" : "Enable notifications"}
				</button>
			) : null}
			<button type="button" aria-label="Dismiss" onClick={dismiss} className="h-11 min-w-11 text-muted">
				✕
			</button>
		</div>
	);
}
