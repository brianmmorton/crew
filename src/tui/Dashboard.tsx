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
import { Panel, PANEL_CHROME, PANEL_CHROME_W } from "./Panel.js";
import { HISTORY_LEGEND, LEGEND } from "./keys.js";

/**
 * The main screen. This component owns ONLY the height budget: it reads the
 * terminal size and the accordion shape, runs the layout math, and hands
 * fixed heights down. Everything below it subscribes to its own store, so
 * "dashboard re-rendered" costs a few memoized children a prop compare.
 *
 * The frame handed to Ink is constant-height for a given terminal size —
 * expanding a pane grows the accordion and shrinks the feed by exactly the
 * same rows, and each section sits in its own bordered Panel whose 2 chrome
 * rows are budgeted in layout.ts. See layout.ts for why this invariant is
 * load-bearing.
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
  // is untouched by it — the frame stays constant-height either way. It leans
  // wider while focused: that's the "I'm reading this" gesture (layout.ts).
  const historyFocused = app.focus === "history";
  const sidebarW = sidebarWidth(app.columns, app.historyVisible, historyFocused);
  const mainW = app.columns - sidebarW;
  // Rows between the header and the footer: what BOTH columns must occupy
  // exactly. Header is 2 lines, footer is 1.
  const bodyH = frameH - 3;
  const agentsH = PANEL_CHROME + listRows + paneH * expandedVisible;
  const outputH = PANEL_CHROME + feedH;

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
        <Box flexDirection="column" width={mainW} height={bodyH} flexShrink={0}>
          <Panel
            title="AGENTS"
            hint="↑↓ navigate · ⏎ expand · r run"
            width={mainW}
            height={agentsH}
            focused={!historyFocused}
          >
            <AgentsPanel listRows={listRows} paneH={paneH} width={mainW - PANEL_CHROME_W} />
          </Panel>
          <Panel title="OUTPUT" hint="all agents · live" width={mainW} height={outputH}>
            <Feed height={feedH} />
          </Panel>
        </Box>
        {sidebarW > 0 && <HistorySidebar width={sidebarW} height={bodyH} />}
      </Box>
      <Footer />
    </Box>
  );
}

/**
 * Subscribes to focus itself rather than taking it as a prop: the legend is
 * the only line in the frame (outside panel borders) that changes on Tab.
 */
const Footer = memo(function Footer(): React.ReactNode {
  const focus = useSnapshot(appStore).focus;
  const legend = focus === "history" ? HISTORY_LEGEND : LEGEND;
  return (
    <Text dimColor wrap="truncate-end">
      {" "}
      {legend}
    </Text>
  );
});
