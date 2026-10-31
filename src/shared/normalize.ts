export type Bag = Record<string, unknown>;
export const isBag = (value: unknown): value is Bag => typeof value === "object" && value !== null;
export const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

export function clamp(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

export const bool = (value: unknown, fallback: boolean): boolean =>
	typeof value === "boolean" ? value : fallback;
