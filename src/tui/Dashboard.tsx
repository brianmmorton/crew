import { memo } from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import { appStore } from "./stores/app.js";
import { agentsStore } from "./stores/agents.js";
import { computeLayout, windowStart } from "./layout.js";
import { Header } from "./Header.js";
import { AgentsPanel } from "./AgentsPanel.js";
import { Feed } from "./Feed.js";
import { LEGEND } from "./keys.js";

/**
 * The main screen. This component owns ONLY the height budget: it reads the
 * terminal size and the accordion shape, runs the layout math, and hands
 * fixed heights down. Everything below it subscribes to its own store, so
 * "dashboard re-rendered" costs four memoized children a prop compare.
 *
 * The frame handed to Ink is constant-height for a given terminal size —
 * expanding a pane grows the accordion and shrinks the feed by exactly the
 * same rows. See layout.ts for why this invariant is load-bearing.
 */
export function Dashboard(): React.ReactNode {
  const app = useSnapshot(appStore);
  const agents = useSnapshot(agentsStore);

  const count = agents.items.length;
  // Two-phase: listRows doesn't depend on expansion, so compute it first,
  // find the visible window, then budget panes for expanded VISIBLE rows only
  // (an expanded row scrolled out of the window takes no space).
  const { listRows } = computeLayout(app.rows, count, 0);
  const start = windowStart(count, listRows, agents.selected);
  const expandedVisible = agents.items
    .slice(start, start + listRows)
    .filter((a) => agents.expanded[a.name]).length;
  const { frameH, paneH, feedH } = computeLayout(app.rows, count, expandedVisible);

  return (
    <Box flexDirection="column" height={frameH}>
      <Header />
      <SectionTitle label="AGENTS" hint="↑↓ navigate · ⏎ expand" />
      <AgentsPanel listRows={listRows} paneH={paneH} />
      <SectionTitle label="OUTPUT" hint="all agents · unified" />
      <Feed height={feedH} />
      <Footer />
    </Box>
  );
}

const SectionTitle = memo(function SectionTitle({
  label,
  hint,
}: {
  label: string;
  hint: string;
}): React.ReactNode {
  return (
    <Text wrap="truncate-end">
      <Text bold color="blueBright">
        {" "}
        {label}
      </Text>
      <Text dimColor>
        {" ── "}
        {hint}
      </Text>
    </Text>
  );
});

const Footer = memo(function Footer(): React.ReactNode {
  return (
    <Text dimColor wrap="truncate-end">
      {" "}
      {LEGEND}
    </Text>
  );
});
