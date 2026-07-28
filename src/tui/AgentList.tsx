import React from "react";
import { Box, Text } from "ink";
import type { AgentRow } from "./snapshot.js";

function schedule(row: AgentRow): string {
  if (row.agent.kind === "executor") return "continuous";
  if (row.agent.kind === "reviewer") return "on-pr";
  if (!row.next) return row.agent.cadence;
  return row.next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function AgentList({ rows }: { rows: AgentRow[] }) {
  return (
    <Box flexDirection="column">
      <Text bold underline>
        AGENTS
      </Text>
      {rows.length === 0 && <Text dimColor>(none found)</Text>}
      {rows.map((row) => (
        <Box key={row.agent.name}>
          <Box width={22}>
            <Text color="cyan">{row.agent.name}</Text>
          </Box>
          <Box width={11}>
            <Text dimColor>{row.agent.kind}</Text>
          </Box>
          <Text dimColor>{schedule(row)}</Text>
        </Box>
      ))}
    </Box>
  );
}
