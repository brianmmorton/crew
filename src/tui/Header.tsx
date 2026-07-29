import { memo } from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import { appStore } from "./stores/app.js";
import { poolStore } from "./stores/pool.js";
import { mcpStore } from "./stores/mcp.js";

/**
 * Two fixed lines. Split into three memoized islands so each re-renders only
 * on ITS store's changes: title (never), board counts (~60s), pool/MCP state
 * (on user action or login change).
 */

const SLOT_GLYPH = { free: "▢", busy: "▣", retained: "▲" } as const;
const SLOT_COLOR = { free: undefined, busy: "yellow", retained: "red" } as const;

const Title = memo(function Title(): React.ReactNode {
  const { project, boardUrl } = useSnapshot(appStore);
  return (
    <Text wrap="truncate-end">
      <Text bold color="cyan">
        {" ⚓ crew"}
      </Text>
      <Text dimColor>{" · "}</Text>
      <Text bold>{project}</Text>
      {boardUrl !== "" && (
        <>
          <Text dimColor>{" · ⎇ "}</Text>
          {/* Same treatment as history's PR links: bright + underlined =
              openable. `b` opens it; cmd+click works where it fits. */}
          <Text color="cyanBright" underline>
            {boardUrl}
          </Text>
        </>
      )}
    </Text>
  );
});

const Board = memo(function Board(): React.ReactNode {
  const pool = useSnapshot(poolStore);
  const stuck = pool.stuck.length;
  return (
    <Text wrap="truncate-end">
      <Text dimColor>backlog </Text>
      <Text color="blueBright">{pool.backlog}</Text>
      <Text dimColor>{"  wip "}</Text>
      <Text color={pool.inProgress >= pool.wipCap ? "yellow" : "magentaBright"}>
        {pool.inProgress}/{pool.wipCap}
      </Text>
      {stuck > 0 && (
        <>
          <Text dimColor>{"  stuck "}</Text>
          <Text color="red" bold>
            {stuck}
          </Text>
        </>
      )}
      {pool.supervisorAlive && <Text color="yellow">{"  ⚠ another crew running"}</Text>}
      <Text> </Text>
    </Text>
  );
});

const PoolLine = memo(function PoolLine(): React.ReactNode {
  const pool = useSnapshot(poolStore);
  return (
    <Text wrap="truncate-end">
      {pool.executorPaused ? (
        <Text color="yellow" bold>
          {" ⏸ pool paused"}
        </Text>
      ) : (
        <Text color="green">{" ▶ pool active"}</Text>
      )}
      <Text dimColor>
        {" · "}
        {pool.workers} worker{pool.workers === 1 ? "" : "s"}
      </Text>
      {pool.slots && (
        <>
          <Text dimColor>{" · slots "}</Text>
          {pool.slots.map((s) => (
            <Text key={s.slot} color={SLOT_COLOR[s.state]} dimColor={s.state === "free"}>
              {SLOT_GLYPH[s.state]}
            </Text>
          ))}
        </>
      )}
    </Text>
  );
});

const McpLine = memo(function McpLine(): React.ReactNode {
  const servers = useSnapshot(mcpStore).servers;
  return (
    <Text wrap="truncate-end">
      <Text dimColor>mcp </Text>
      {servers.length === 0 && <Text dimColor>none</Text>}
      {servers.map((s, i) => (
        <Text key={s.server}>
          {i > 0 && <Text dimColor> </Text>}
          {s.loggedIn === null ? (
            <Text color="cyan">● {s.server}</Text>
          ) : s.loggedIn ? (
            <Text color="green">● {s.server}</Text>
          ) : (
            <Text color="red">○ {s.server}</Text>
          )}
        </Text>
      ))}
      <Text> </Text>
    </Text>
  );
});

export function Header(): React.ReactNode {
  return (
    <Box flexDirection="column" height={2} flexShrink={0}>
      <Box justifyContent="space-between">
        <Title />
        <Board />
      </Box>
      <Box justifyContent="space-between">
        <PoolLine />
        <McpLine />
      </Box>
    </Box>
  );
}
