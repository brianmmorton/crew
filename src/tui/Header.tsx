import React from "react";
import { Box, Text } from "ink";
import type { Snapshot } from "./snapshot.js";

function poolCounts(slots: Snapshot["slots"]): string | null {
  if (!slots) return null;
  const count = (s: string) => slots.filter((x) => x.state === s).length;
  return `${count("free")} free  ${count("busy")} busy  ${count("retained")} retained`;
}

export function Header({ snap }: { snap: Snapshot }) {
  const pool = poolCounts(snap.slots);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">
          crew
        </Text>
        <Text dimColor>  {snap.cfg.project}</Text>
        <Text dimColor>  ·  {snap.cfg.repo.path.split("/").pop()}</Text>
        <Box flexGrow={1} />
        <Text color={snap.supervisorAlive ? "green" : "yellow"}>
          {snap.supervisorAlive ? "● running" : "○ not running"}
        </Text>
      </Box>
      <Box>
        <Text dimColor>backlog </Text>
        <Text>
          {snap.backlog}/{snap.cfg.triager.backlogCap}
        </Text>
        <Text dimColor>   wip </Text>
        <Text>
          {snap.inProgress}/{snap.cfg.gates.wipCap}
        </Text>
        {pool && (
          <>
            <Text dimColor>   pool </Text>
            <Text>{pool}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
