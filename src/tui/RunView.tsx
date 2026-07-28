import React from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import type { AgentRun } from "./runManager.js";
import { Spinner } from "./Spinner.js";
import { store } from "./store.js";

const STATUS_COLOR: Record<AgentRun["status"], string> = {
  running: "yellow",
  exited: "green",
  failed: "red",
};

function elapsed(run: AgentRun): string {
  const end = run.endedAt ?? new Date();
  const secs = Math.max(0, Math.round((end.getTime() - run.startedAt.getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
}

/**
 * Full-screen tail of one agent's live `crew once` output. Reads the run
 * from the store itself via useSnapshot rather than taking it as a plain
 * prop — App only reads the agent name (a stable string), so this is the
 * component that needs to be reactive to the run's streaming `lines`.
 */
export function RunView({ agent, height }: { agent: string; height: number }) {
  const { runs } = useSnapshot(store);
  const run = runs.get(agent) as AgentRun | undefined;
  if (!run) return null;
  const visible = run.lines.slice(-height);
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          {run.agent}
        </Text>
        <Text dimColor>  </Text>
        {run.status === "running" && <Spinner color="yellow" />}
        <Text color={STATUS_COLOR[run.status]}>
          {run.status === "running" ? " running" : run.status}
          {run.exitCode !== null && run.exitCode !== 0 ? ` (exit ${run.exitCode})` : ""}
        </Text>
        <Text dimColor>  {elapsed(run)}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {visible.length === 0 && run.status === "running" && (
          <Text dimColor>
            <Spinner /> waiting for the agent's first line of output…
          </Text>
        )}
        {visible.length === 0 && run.status !== "running" && <Text dimColor>(no output)</Text>}
        {visible.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[esc] back to dashboard{run.status === "running" ? "   [k] stop run" : ""}</Text>
      </Box>
    </Box>
  );
}
