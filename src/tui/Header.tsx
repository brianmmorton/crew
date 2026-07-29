import React from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import type { Snapshot } from "./snapshot.js";
import { Logo } from "./Logo.js";
import { store } from "./store.js";
import type { DeepReadonly } from "./deepReadonly.js";
import { useRenderTrace } from "./useRenderTrace.js";

function poolCounts(slots: DeepReadonly<Snapshot["slots"]>): string | null {
  if (!slots) return null;
  const count = (s: string) => slots.filter((x) => x.state === s).length;
  return `${count("free")} free  ${count("busy")} busy  ${count("retained")} retained`;
}

/**
 * Reads only store.snap and store.headerLogo — re-renders independently of
 * AgentList/LogPanel. Memoized (no props) so Screen's own re-renders (e.g.
 * on store.rows changing) don't cascade into this subtree too.
 */
export const Header = React.memo(function Header() {
  const { snap, headerLogo: logoArt } = useSnapshot(store);
  useRenderTrace("Header", { snap, logoArt });
  if (!snap) return null;
  const pool = poolCounts(snap.slots);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {logoArt && <Logo art={logoArt} />}
      <Box>
        {!logoArt && (
          <Text bold color="cyan">
            crew
          </Text>
        )}
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
      {snap.mcpOAuth.length > 0 && (
        <Box>
          <Text dimColor>mcp </Text>
          {snap.mcpOAuth.map((row, i) => (
            <Text key={row.server}>
              {i > 0 && <Text dimColor>  </Text>}
              <Text color={row.loggedIn ? "green" : "yellow"}>
                {row.loggedIn ? "●" : "○"} {row.server}
              </Text>
            </Text>
          ))}
          {snap.mcpOAuth.some((r) => !r.loggedIn) && (
            <Text dimColor>   (crew mcp login &lt;server&gt;)</Text>
          )}
        </Box>
      )}
    </Box>
  );
});
