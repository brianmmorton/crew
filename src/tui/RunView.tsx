import React from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import type { AgentRun } from "./runManager.js";
import { Spinner } from "./Spinner.js";
import { store } from "./store.js";
import { useRenderTrace } from "./useRenderTrace.js";

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
  useRenderTrace("RunView", { agent, height, run });
  if (!run) return null;

  // `height` is the whole view's budget, not the output pane's, so the chrome
  // comes out of it before slicing: 1 header + 1 blank + 1 blank + 1 footer.
  // Without this the pane took `height` lines and the chrome was added on top,
  // overflowing a short terminal outright.
  const CHROME = 4;

  const outputHeight = Math.max(1, height - CHROME);
  const tail = run.lines.slice(-outputHeight);

  // Padded to a constant `outputHeight`, never just `slice`d. This is what
  // stops the stacked "qa ⠸ running" ladder, and the reason is Ink's renderer
  // rather than anything about the bottom of the screen: on a frame that grew
  // since the last paint it emits `cursorUp(previousHeight - 1)` and then walks
  // down over `nextHeight` lines, descending further than it climbed. The block
  // anchor slides down by the difference, and the next spinner tick repaints
  // from that wrong anchor — one rung per line the agent streamed. A pane of
  // fixed height never grows, so the anchor never moves.
  //
  // The height is declared on the Box rather than padded in with blank Text
  // rows: trailing whitespace-only lines get trimmed on the way to the
  // terminal, so string padding disappears at exactly the moment it is meant
  // to be holding the pane open. An explicit `height` makes the layout engine
  // reserve the rows, which survives trimming.
  const visible = tail;
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
      <Box marginTop={1} flexDirection="column" height={outputHeight} flexShrink={0}>
        {/*
          Output is bottom-aligned inside the fixed pane, so the newest line
          sits just above the footer and earlier lines scroll up off the top —
          the direction a terminal reader expects. With the pane top-aligned
          instead, a short run would leave its output stranded at the top with
          a gap beneath it.
        */}
        <Box flexGrow={1} />
        {visible.length === 0 &&
          (run.status === "running" ? (
            <Text dimColor>
              <Spinner /> waiting for the agent&apos;s first line of output…
            </Text>
          ) : (
            <Text dimColor>(no output)</Text>
          ))}
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
