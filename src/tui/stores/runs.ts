import { proxy } from "valtio";
import type { PersonaName } from "../../types.js";

/**
 * Live `crew once <agent>` runs, split across TWO stores so subscriptions
 * stay narrow:
 *
 * - `runsStore.byAgent[name]` — small metadata (status, timestamps). Read by
 *   the collapsed agent row; changes a few times per run.
 * - `runOutputStore.byAgent[name]` — the streamed output lines. Read only by
 *   that agent's expanded pane; changes on every chunk.
 *
 * With the split, output streaming re-renders only the expanded pane of the
 * agent producing it — collapsed rows and other panes never see it.
 */

export type RunStatus = "running" | "paused" | "done" | "failed";

export interface RunMeta {
  agent: PersonaName;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
}

export const MAX_RUN_LINES = 2000;

export const runsStore = proxy({
  byAgent: {} as Record<string, RunMeta>,
});

export const runOutputStore = proxy({
  byAgent: {} as Record<string, string[]>,
});

export function beginRun(agent: PersonaName): void {
  runsStore.byAgent[agent] = {
    agent,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
  };
  runOutputStore.byAgent[agent] = [];
}

export function appendRunOutput(agent: PersonaName, lines: string[]): void {
  if (!lines.length) return;
  const prev = runOutputStore.byAgent[agent] ?? [];
  runOutputStore.byAgent[agent] = [...prev, ...lines].slice(-MAX_RUN_LINES);
}

export function setRunStatus(agent: PersonaName, status: RunStatus, exitCode?: number | null): void {
  const run = runsStore.byAgent[agent];
  if (!run) return;
  run.status = status;
  if (status === "done" || status === "failed") {
    run.endedAt = Date.now();
    run.exitCode = exitCode ?? null;
  }
}

export function isRunActive(agent: PersonaName): boolean {
  const s = runsStore.byAgent[agent]?.status;
  return s === "running" || s === "paused";
}

export function resetRunsStore(): void {
  runsStore.byAgent = {};
  runOutputStore.byAgent = {};
}
