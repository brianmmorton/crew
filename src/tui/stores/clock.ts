import { proxy } from "valtio";

/**
 * A once-a-second heartbeat for live durations ("running 00:42"). Components
 * read `clockStore.now` ONLY on the code path that displays a duration —
 * valtio tracks property access, so an idle row that never touches `.now`
 * doesn't re-render on the tick.
 */
export const clockStore = proxy({ now: Date.now() });

export function tickClock(): void {
  clockStore.now = Date.now();
}
