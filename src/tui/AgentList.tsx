import React from "react";
import { Box, Text } from "ink";
import type { AgentRow } from "./snapshot.js";
import type { AgentRun } from "./runManager.js";
import { Spinner } from "./Spinner.js";

function schedule(row: AgentRow): string {
  if (row.agent.kind === "executor") return "continuous";
  if (row.agent.kind === "reviewer") return "on-pr";
  if (!row.next) return row.agent.cadence;
  return row.next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const RUN_BADGE: Record<Exclude<AgentRun["status"], "running">, { text: string; color: string }> = {
  exited: { text: "✓ done", color: "green" },
  failed: { text: "✗ failed", color: "red" },
};

export function AgentList({
  rows,
  runs,
  selected,
}: {
  rows: AgentRow[];
  runs: Map<string, AgentRun>;
  selected: number;
}) {
  return (
    <Box flexDirection="column">
      <Text bold underline>
        AGENTS
      </Text>
      {rows.length === 0 && <Text dimColor>(none found)</Text>}
      {rows.map((row, i) => {
        const isSelected = i === selected;
        const run = runs.get(row.agent.name);
        const runnable = row.agent.kind !== "reviewer";
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
            {run?.status === "running" && (
              <Text color="yellow">
                <Spinner color="yellow" /> running
              </Text>
            )}
            {badge && <Text color={badge.color}>{badge.text}</Text>}
            {!run && !runnable && <Text dimColor>(runs on PR only)</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
