import { proxy } from "valtio";
import type { SlotState } from "../../git/pool.js";

/**
 * Executor + worker-pool + tracker state for the header and the executor's
 * expanded pane. Everything here changes on the 1s poll (guarded against
 * no-op writes in bootstrap.ts) or on an explicit user action.
 */

export interface SlotView {
  slot: number;
  state: SlotState;
  branch: string | null;
}

export interface StuckView {
  identifier: string;
  state: "abandoned" | "fixing" | "working";
  reason: string | null;
}

export const poolStore = proxy({
  /** True while `setPaused(true)` — workers stop claiming NEW work. */
  executorPaused: false,
  workers: 1,
  wipCap: 0,
  backlog: 0,
  inProgress: 0,
  /** null when worktree reuse is off. */
  slots: null as SlotView[] | null,
  /** In-flight/stuck items, shown in the executor's expanded pane. */
  stuck: [] as StuckView[],
  /** Another crew supervisor process owns state.json's pid. */
  supervisorAlive: false,
});

/**
 * "Refresh the tracker counts now" flag, set when local state shows work
 * moved (a run finishing). A plain module flag, not proxy state — nothing
 * renders from it, and it's written from child-process exit handlers that
 * must not trigger re-renders.
 */
let trackerDirty = false;

export function invalidateTrackerCounts(): void {
  trackerDirty = true;
}

export function takeTrackerDirty(): boolean {
  const was = trackerDirty;
  trackerDirty = false;
  return was;
}

export function resetPoolStore(): void {
  poolStore.executorPaused = false;
  poolStore.workers = 1;
  poolStore.wipCap = 0;
  poolStore.backlog = 0;
  poolStore.inProgress = 0;
  poolStore.slots = null;
  poolStore.stuck = [];
  poolStore.supervisorAlive = false;
  trackerDirty = false;
}
