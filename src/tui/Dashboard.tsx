import { memo } from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import { appStore } from "./stores/app.js";
import { agentsStore } from "./stores/agents.js";
import { computeLayout, sidebarWidth, windowStart } from "./layout.js";
import { Header } from "./Header.js";
import { AgentsPanel } from "./AgentsPanel.js";
import { HistorySidebar } from "./HistorySidebar.js";
import { Feed } from "./Feed.js";
import { HISTORY_LEGEND, LEGEND } from "./keys.js";

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

  // The sidebar is a WIDTH split and takes no rows, so the height budget above
  // is untouched by it — the frame stays constant-height either way.
  const sidebarW = sidebarWidth(app.columns, app.historyVisible);
  // Rows between the header and the footer: what BOTH columns must occupy
  // exactly. Header is 2 lines, footer is 1.
  const bodyH = frameH - 3;

  return (
    <Box flexDirection="column" height={frameH} flexShrink={0}>
      <Header />
      {/*
        Both columns are pinned to `bodyH` and neither may grow: with
        incrementalRendering, a row whose height is decided by its tallest
        child re-anchors Ink's line diff when the sidebar's content changes,
        which duplicates section headers and the footer on the next paint.
        Fixed heights on both sides, and no flexGrow anywhere in the frame.
      */}
      <Box flexDirection="row" height={bodyH} flexShrink={0}>
        <Box flexDirection="column" width={app.columns - sidebarW} height={bodyH} flexShrink={0}>
          <SectionTitle label="AGENTS" hint="↑↓ navigate · ⏎ expand" />
          <AgentsPanel listRows={listRows} paneH={paneH} />
          <SectionTitle label="OUTPUT" hint="all agents · unified" />
          <Feed height={feedH} />
        </Box>
        {sidebarW > 0 && <HistorySidebar width={sidebarW} height={bodyH} />}
      </Box>
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

/**
 * Subscribes to focus itself rather than taking it as a prop: the legend is
 * the only thing in the frame that changes on Tab, so this keeps a focus
 * switch to a one-line repaint.
 */
const Footer = memo(function Footer(): React.ReactNode {
  const focus = useSnapshot(appStore).focus;
  return (
    <Text dimColor wrap="truncate-end">
      {" "}
      {focus === "history" ? HISTORY_LEGEND : LEGEND}
    </Text>
  );
});
