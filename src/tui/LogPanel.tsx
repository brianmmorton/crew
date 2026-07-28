import React from "react";
import { Box, Text } from "ink";

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

export function LogPanel({ lines, height }: { lines: string[]; height: number }) {
  const visible = lines.slice(-height);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold underline>
        LOG
      </Text>
      {visible.length === 0 && <Text dimColor>(no log output yet)</Text>}
      {visible.map((line, i) => {
        const parsed = parseLine(line);
        if (!parsed) {
          return (
            <Text key={i} dimColor wrap="truncate-end">
              {line}
            </Text>
          );
        }
        return (
          <Box key={i}>
            <Box width={13}>
              <Text dimColor>{parsed.ts}</Text>
            </Box>
            <Box width={6}>
              <Text color={LEVEL_COLOR[parsed.level] ?? "white"}>{parsed.level}</Text>
            </Box>
            <Text wrap="truncate-end">{parsed.msg}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
