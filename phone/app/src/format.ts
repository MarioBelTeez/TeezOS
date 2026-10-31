/** Small, pure formatting for the screens. */

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function bytes(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0 B";
	const power = Math.min(UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
	const scaled = value / 1024 ** power;
	return `${scaled >= 100 || power === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${UNITS[power]}`;
}

export function percent(used: number, total: number): number {
	return total > 0 ? Math.round((used / total) * 100) : 0;
}

/** Seconds as "3d 4h", "2h 5m", "4m", "12s". */
export function duration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "–";
	const s = Math.round(seconds);
	const d = Math.floor(s / 86_400);
	const h = Math.floor((s % 86_400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m`;
	return `${s}s`;
}

/** An epoch-ms moment as "just now", "5 min ago", "3 h ago", or a date. */
export function ago(epochMs: number, now: number = Date.now()): string {
	const seconds = Math.max(0, (now - epochMs) / 1000);
	if (seconds < 45) return "just now";
	if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
	return new Date(epochMs).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
