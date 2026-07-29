import React from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import { store } from "./store.js";
import { useRenderTrace } from "./useRenderTrace.js";

const LEVEL_COLOR: Record<string, string> = {
  INFO: "blue",
  WARN: "yellow",
  ERROR: "red",
};

/** Splits a `crew.log` line into its timestamp/level/message parts, if it matches. */
function parseLine(line: string): { ts: string; level: string; msg: string } | null {
  const m = /^(\S+)\s+(INFO|WARN|ERROR)\s+(.*)$/.exec(line);
  if (!m) return null;
  const [, ts, level, msg] = m;
  const time = ts.includes("T") ? ts.split("T")[1]?.replace("Z", "") ?? ts : ts;
  return { ts: time, level, msg };
}

/**
 * One log row, memoized on its text. Appending a line shifts every row up by
 * one, so without this each new line re-renders and re-parses the whole
 * panel. Keyed by content below, so a row that scrolled but didn't change
 * keeps its element and bails out here.
 */
const LogLine = React.memo(function LogLine({ line }: { line: string }) {
  const parsed = parseLine(line);
  if (!parsed) {
    return (
      <Text dimColor wrap="truncate-end">
        {line}
      </Text>
    );
  }
  return (
    <Box>
      <Box width={13}>
        <Text dimColor>{parsed.ts}</Text>
      </Box>
      <Box width={6}>
        <Text color={LEVEL_COLOR[parsed.level] ?? "white"}>{parsed.level}</Text>
      </Box>
      <Text wrap="truncate-end">{parsed.msg}</Text>
    </Box>
  );
});

/**
 * Reads only store.logLines — the highest-frequency slice, isolated so its
 * updates never touch Header/AgentList. Memoized on its one primitive prop
 * so Screen's own re-renders don't cascade in.
 */
export const LogPanel = React.memo(function LogPanel({ height }: { height: number }) {
  const { logLines } = useSnapshot(store);
  // `height` and `logLines` are the only two inputs, so the changed= list on
  // each trace line says outright whether this panel is repainting because new
  // output arrived or because the frame's layout math handed it a new height.
  useRenderTrace("LogPanel", { height, logLines, count: logLines.length });
  // `start` is the visible window's offset into the whole buffer, so each row
  // can be keyed by its absolute position rather than its index in the slice.
  const start = Math.max(0, logLines.length - height);
  const visible = logLines.slice(start);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold underline>
        LOG
      </Text>
      {visible.length === 0 && <Text dimColor>(no log output yet)</Text>}
      {visible.map((line, i) => (
        // Keyed by absolute position in the buffer, which is stable as the
        // window scrolls: a row that only moved up keeps its element, so
        // LogLine's memo skips re-parsing it. A plain index key would
        // renumber every row on append and re-render the whole panel.
        <LogLine key={start + i} line={line} />
      ))}
    </Box>
  );
});
