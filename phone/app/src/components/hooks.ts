import { useCallback, useEffect, useRef, useState, type TouchEvent } from "react";
import { request, type ApiResult } from "../api.ts";

/**
 * A GET the screen shows: loads when the screen is active, again every
 * `everyMs` while it stays active (0 = never), and on demand via `reload`.
 * The last good data stays on screen while a reload fails.
 */
export function useResource<T>(path: string | null, active: boolean, everyMs = 0) {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<{ text: string; offline: boolean } | null>(null);
	const [loading, setLoading] = useState(false);
	const pathRef = useRef(path);
	pathRef.current = path;

	const reload = useCallback(async (): Promise<ApiResult<T> | null> => {
		const wanted = pathRef.current;
		if (wanted === null) return null;
		setLoading(true);
		const result = await request<T>(wanted);
		if (pathRef.current !== wanted) return result;
		setLoading(false);
		if (result.ok) {
			setData(result.data);
			setError(null);
		} else setError({ text: result.error, offline: result.offline });
		return result;
	}, []);

	useEffect(() => {
		setData(null);
		setError(null);
	}, [path]);

	useEffect(() => {
		if (!active || path === null) return;
		void reload();
		if (everyMs <= 0) return;
		const timer = setInterval(() => void reload(), everyMs);
		return () => clearInterval(timer);
	}, [active, path, everyMs, reload]);

	return { data, error, loading, reload };
}

const PULL_DISTANCE = 70;
export type PullState = "idle" | "pulling" | "ready" | "refreshing";

/**
 * Pull to refresh for a scrolling list: a pull down from the very top past
 * PULL_DISTANCE refreshes on release. Classes, not inline styles (CSP).
 */
export function usePullToRefresh(refresh: () => Promise<unknown>) {
	const start = useRef<number | null>(null);
	const [state, setState] = useState<PullState>("idle");

	const onTouchStart = (event: TouchEvent<HTMLElement>): void => {
		start.current = event.currentTarget.scrollTop <= 0 ? (event.touches[0]?.clientY ?? null) : null;
	};
	const onTouchMove = (event: TouchEvent<HTMLElement>): void => {
		if (start.current === null || state === "refreshing") return;
		const pulled = (event.touches[0]?.clientY ?? 0) - start.current;
		setState(pulled > PULL_DISTANCE ? "ready" : pulled > 10 ? "pulling" : "idle");
	};
	const onTouchEnd = (): void => {
		start.current = null;
		if (state !== "ready") {
			if (state !== "refreshing") setState("idle");
			return;
		}
		setState("refreshing");
		void refresh().finally(() => setState("idle"));
	};

	return { state, handlers: { onTouchStart, onTouchMove, onTouchEnd } };
}
