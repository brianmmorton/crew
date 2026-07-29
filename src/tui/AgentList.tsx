import React from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import type { AgentRow } from "./snapshot.js";
import type { AgentRun } from "./runManager.js";
import { Spinner } from "./Spinner.js";
import { store } from "./store.js";
import type { DeepReadonly } from "./deepReadonly.js";
import { useRenderTrace } from "./useRenderTrace.js";

function schedule(row: DeepReadonly<AgentRow>): string {
  if (row.agent.kind === "executor") return "continuous";
  if (row.agent.kind === "reviewer") return "on-pr";
  if (!row.next) return row.agent.cadence;
  return row.next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const RUN_BADGE: Record<Exclude<AgentRun["status"], "running">, { text: string; color: string }> = {
  exited: { text: "✓ done", color: "green" },
  failed: { text: "✗ failed", color: "red" },
};

/**
 * Reads rows/runs/selected/implPaused from the store — re-renders on
 * spinner ticks and run updates independently of Header/LogPanel. Memoized
 * on its one primitive prop so Screen's own re-renders don't cascade in.
 */
export const AgentList = React.memo(function AgentList({
  implWorkers,
  maxRows,
  /**
   * Whether the executor is actually mid-cycle on something. Only then does
   * its row animate: the spinner is a shared 120ms ticker, and an unconditional
   * one on the always-present executor row re-rendered this list ~8x a second
   * forever, even on a fully idle TUI with no work in flight. An idle executor
   * now shows a static mark instead, so a quiet dashboard issues no repaints.
   */
  executorBusy = false,
}: {
  implWorkers: number;
  /** Rows the frame has room for; the rest are dropped so it can't overflow. */
  maxRows?: number;
  executorBusy?: boolean;
}) {
  const snap = useSnapshot(store);
  const all = snap.snap?.agentRows ?? [];
  // `agentRows` is watched by identity: the poller rebuilds a whole Snapshot
  // every tick, so if publishSnapshot's equality check ever lets an unchanged
  // tick through, it shows up here as agentRows changing once a second with no
  // visible difference on screen.
  useRenderTrace("AgentList", {
    maxRows,
    implWorkers,
    executorBusy,
    agentRows: all,
    runs: snap.runs,
    selected: snap.selected,
    implPaused: snap.implPaused,
  });
  const rows = maxRows === undefined ? all : all.slice(0, maxRows);
  // Clamped rather than read raw: the row list can shrink between polls, and
  // a stale index would otherwise paint no cursor at all (or, before rows
  // were deduped by name, one on each duplicate).
  const selected = Math.min(snap.selected, Math.max(0, rows.length - 1));
  const implPaused = snap.implPaused;
  return (
    <Box flexDirection="column">
      <Text bold underline>
        AGENTS
        {all.length > rows.length ? `  (${rows.length} of ${all.length})` : ""}
      </Text>
      {rows.length === 0 && <Text dimColor>(none found)</Text>}
      {rows.map((row, i) => {
        const isSelected = i === selected;
        const isExecutor = row.agent.kind === "executor";
        const run = snap.runs.get(row.agent.name) as AgentRun | undefined;
        const runnable = row.agent.kind !== "reviewer" && !isExecutor;
        const badge = run && run.status !== "running" ? RUN_BADGE[run.status] : null;
        return (
          <Box key={row.agent.name}>
            <Box width={2} flexShrink={0}>
              <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                {isSelected ? "❯ " : "  "}
              </Text>
            </Box>
            <Box width={22} flexShrink={0}>
              <Text color="cyan">{row.agent.name}</Text>
            </Box>
            <Box width={11} flexShrink={0}>
              <Text dimColor>{row.agent.kind}</Text>
            </Box>
            <Box width={12} flexShrink={0}>
              <Text dimColor>{schedule(row)}</Text>
            </Box>
            {isExecutor && implPaused && <Text dimColor>⏸ paused</Text>}
            {isExecutor && !implPaused && executorBusy && (
              <Text color="yellow">
                <Spinner color="yellow" /> running ({implWorkers}w)
              </Text>
            )}
            {isExecutor && !implPaused && !executorBusy && (
              <Text dimColor>○ idle ({implWorkers}w)</Text>
            )}
            {!isExecutor && run?.status === "running" && (
              <Text color="yellow">
                <Spinner color="yellow" /> running
              </Text>
            )}
            {!isExecutor && badge && <Text color={badge.color}>{badge.text}</Text>}
            {!run && !runnable && !isExecutor && <Text dimColor>(runs on PR only)</Text>}
          </Box>
        );
      })}
    </Box>
  );
});
