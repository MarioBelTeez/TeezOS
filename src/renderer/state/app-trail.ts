import { createHistory } from "../../shared/history.ts";

/**
 * Where you have been in the app as a whole: the views (Code, Brain, Feed, ...)
 * and the desks you switched to. Entries are `view:<id>` or `desk:<id>`.
 * Recorded by showView / switchDesk; Back and Forward step along without adding.
 */
export const appTrail = createHistory<string>();
// Code is what a window opens on, so the first view change can be walked back.
appTrail.push("view:code");

/** A desk switch the user made: the desk left is the trail's start if nothing was recorded, then the new one. Back/Forward never call this. */
export function recordDeskSwitch(from: string, to: string): void {
	appTrail.push(deskEntry(from));
	appTrail.push(deskEntry(to));
}

export const viewEntry = (view: string): string => `view:${view}`;
export const deskEntry = (id: string): string => `desk:${id}`;
