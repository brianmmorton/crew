// Tests are excluded from tsconfig (they never ship), so tsx transpiles this
// file's JSX with the classic runtime — the explicit React import is required
// here even though src files use the automatic runtime.
import React from "react";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { keyToAction } from "./keys.js";
import { computeLayout, fmtElapsed, fmtUntil, windowStart, MIN_FEED, PANE_MIN } from "./layout.js";
import { agentColor } from "./palette.js";
import { appStore, beginStep, endSteps, failBoot, resetAppStore } from "./stores/app.js";
import {
  agentsStore,
  moveSelection,
  resetAgentsStore,
  setAgents,
  toggleExpanded,
  type AgentItem,
} from "./stores/agents.js";
import {
  appendRunOutput,
  beginRun,
  resetRunsStore,
  runOutputStore,
  runsStore,
  setRunStatus,
  MAX_RUN_LINES,
} from "./stores/runs.js";
import {
  appendAgentLines,
  appendEngineLines,
  feedStore,
  resetFeedStore,
  MAX_FEED_LINES,
} from "./stores/feed.js";
import { poolStore, resetPoolStore, invalidateTrackerCounts, takeTrackerDirty } from "./stores/pool.js";
import { resetMcpStore, mcpStore } from "./stores/mcp.js";
import { Dashboard } from "./Dashboard.js";
import { Loading } from "./Loading.js";
import { ErrorScreen } from "./ErrorScreen.js";

beforeEach(() => {
  resetAppStore();
  resetAgentsStore();
  resetRunsStore();
  resetFeedStore();
  resetPoolStore();
  resetMcpStore();
});

function seedAgents(names: string[], kinds?: string[]): void {
  setAgents(
    names.map(
      (name, i): AgentItem => ({
        name,
        kind: (kinds?.[i] ?? "proposer") as AgentItem["kind"],
        cadence: "0 9 * * *",
        nextRun: Date.now() + 3_600_000,
      }),
    ),
  );
}

// ----------------------------- keys ----------------------------------------

test("keys: navigation, expand, run, pause, stop, quit all map", () => {
  assert.deepEqual(keyToAction("", { upArrow: true }), { type: "up" });
  assert.deepEqual(keyToAction("k", {}), { type: "up" });
  assert.deepEqual(keyToAction("", { downArrow: true }), { type: "down" });
  assert.deepEqual(keyToAction("j", {}), { type: "down" });
  assert.deepEqual(keyToAction("", { return: true }), { type: "toggle-expand" });
  assert.deepEqual(keyToAction("", { rightArrow: true }), { type: "toggle-expand" });
  assert.deepEqual(keyToAction("", { escape: true }), { type: "collapse-all" });
  assert.deepEqual(keyToAction("r", {}), { type: "run-selected" });
  assert.deepEqual(keyToAction("3", {}), { type: "run-index", index: 2 });
  assert.deepEqual(keyToAction(" ", {}), { type: "pause-agent" });
  assert.deepEqual(keyToAction("p", {}), { type: "pause-pool" });
  assert.deepEqual(keyToAction("x", {}), { type: "stop-agent" });
  assert.deepEqual(keyToAction("q", {}), { type: "quit" });
  assert.deepEqual(keyToAction("c", { ctrl: true }), { type: "quit" });
  assert.equal(keyToAction("z", {}), null);
});

// ----------------------------- layout --------------------------------------

test("layout: frame height is constant regardless of accordion state", () => {
  for (const rows of [20, 24, 40, 60]) {
    const heights = new Set<number>();
    for (const expanded of [0, 1, 2, 3]) {
      heights.add(computeLayout(rows, 5, expanded).frameH);
    }
    assert.equal(heights.size, 1, `frameH varied at rows=${rows}`);
  }
});

test("layout: expanding panes takes rows from the feed, total stays balanced", () => {
  const rows = 40;
  const agentCount = 5;
  for (const expanded of [0, 1, 2]) {
    const l = computeLayout(rows, agentCount, expanded);
    // header(2) + titles(2) + footer(1) + list + panes + feed === frame
    const used = 5 + l.listRows + expanded * l.paneH + l.feedH;
    assert.equal(used, l.frameH, `unbalanced at expanded=${expanded}`);
    assert.ok(l.feedH >= 1);
  }
});

test("layout: feed keeps minimum rows and panes vanish when too tight", () => {
  const tight = computeLayout(14, 6, 4);
  assert.equal(tight.paneH, 0); // no room — markers only
  assert.ok(tight.feedH >= 1);
  const roomy = computeLayout(50, 3, 1);
  assert.ok(roomy.paneH >= PANE_MIN);
  assert.ok(roomy.feedH >= MIN_FEED);
});

test("layout: windowStart keeps the selection visible", () => {
  assert.equal(windowStart(3, 5, 2), 0); // fits — no scroll
  assert.equal(windowStart(20, 5, 0), 0);
  assert.equal(windowStart(20, 5, 19), 15); // clamped to the end
  const mid = windowStart(20, 5, 10);
  assert.ok(mid <= 10 && 10 < mid + 5);
});

test("layout: elapsed/until formatting", () => {
  assert.equal(fmtElapsed(0, 65_000), "01:05");
  assert.equal(fmtElapsed(0, 3_600_000), "1:00:00");
  assert.equal(fmtUntil(Date.now() - 1000, Date.now()), "due");
  assert.equal(fmtUntil(Date.now() + 30 * 60_000, Date.now()), "in 30m");
});

// ----------------------------- palette -------------------------------------

test("palette: agent colors are stable across calls", () => {
  assert.equal(agentColor("qa"), agentColor("qa"));
});

// ----------------------------- stores --------------------------------------

test("agents store: selection clamps at both ends and expansion toggles", () => {
  seedAgents(["a", "b", "c"]);
  moveSelection(-1);
  assert.equal(agentsStore.selected, 0);
  moveSelection(1);
  moveSelection(1);
  moveSelection(1);
  assert.equal(agentsStore.selected, 2); // clamped
  toggleExpanded("b");
  assert.equal(agentsStore.expanded["b"], true);
  toggleExpanded("b");
  assert.equal(agentsStore.expanded["b"], false);
});

test("agents store: shrinking the roster pulls the cursor back in range", () => {
  seedAgents(["a", "b", "c"]);
  agentsStore.selected = 2;
  seedAgents(["a"]);
  assert.equal(agentsStore.selected, 0);
});

test("runs store: lifecycle and output cap", () => {
  beginRun("qa");
  assert.equal(runsStore.byAgent["qa"]!.status, "running");
  appendRunOutput("qa", Array.from({ length: MAX_RUN_LINES + 50 }, (_, i) => `l${i}`));
  assert.equal(runOutputStore.byAgent["qa"]!.length, MAX_RUN_LINES);
  setRunStatus("qa", "done", 0);
  assert.equal(runsStore.byAgent["qa"]!.status, "done");
  assert.equal(runsStore.byAgent["qa"]!.exitCode, 0);
  assert.ok(runsStore.byAgent["qa"]!.endedAt !== null);
});

test("feed store: parses engine lines, tags agent lines, caps the ring", () => {
  appendEngineLines(["2026-07-28T10:11:12.000Z INFO executor idle: nothing ready"]);
  appendEngineLines(["not a log line"]);
  appendAgentLines("qa", ["found a bug"]);
  const [engine, raw, agent] = feedStore.lines;
  assert.equal(engine!.level, "info");
  assert.equal(engine!.time, "10:11:12");
  assert.equal(engine!.text, "executor idle: nothing ready");
  assert.equal(raw!.level, null);
  assert.equal(agent!.source, "qa");

  appendEngineLines(Array.from({ length: MAX_FEED_LINES + 10 }, (_, i) => `x${i}`));
  assert.equal(feedStore.lines.length, MAX_FEED_LINES);
  // ids stay unique + monotonic after the splice
  const ids = feedStore.lines.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("pool store: tracker dirty flag reads once", () => {
  assert.equal(takeTrackerDirty(), false);
  invalidateTrackerCounts();
  assert.equal(takeTrackerDirty(), true);
  assert.equal(takeTrackerDirty(), false);
});

test("app store: boot steps advance and failure marks the trailing step", () => {
  beginStep("one");
  beginStep("two");
  assert.deepEqual(
    appStore.steps.map((s) => s.status),
    ["done", "active"],
  );
  failBoot("boom");
  assert.equal(appStore.phase, "error");
  assert.equal(appStore.error, "boom");
  assert.deepEqual(
    appStore.steps.map((s) => s.status),
    ["done", "failed"],
  );
  resetAppStore();
  beginStep("only");
  endSteps(true);
  assert.deepEqual(
    appStore.steps.map((s) => s.status),
    ["done"],
  );
});

// ----------------------------- render smoke --------------------------------

const frameHeight = (frame: string | undefined): number => (frame ?? "").split("\n").length;

test("render: dashboard shows agents, statuses, mcp and legend", () => {
  appStore.rows = 30;
  appStore.project = "myproject";
  seedAgents(["qa", "design", "implementer"], ["proposer", "proposer", "executor"]);
  poolStore.backlog = 12;
  poolStore.inProgress = 2;
  poolStore.wipCap = 3;
  mcpStore.servers = [
    { server: "linear", oauth: true, loggedIn: true },
    { server: "github", oauth: true, loggedIn: false },
  ];
  beginRun("qa");

  const { lastFrame, unmount } = render(<Dashboard />);
  const frame = lastFrame() ?? "";
  unmount();

  assert.match(frame, /crew/);
  assert.match(frame, /myproject/);
  assert.match(frame, /qa/);
  assert.match(frame, /design/);
  assert.match(frame, /implementer/);
  assert.match(frame, /running/); // qa's live run
  assert.match(frame, /backlog 12/);
  assert.match(frame, /wip 2\/3/);
  assert.match(frame, /linear/);
  assert.match(frame, /github/);
  assert.match(frame, /q quit/);
});

test("render: frame height never changes when the accordion opens", () => {
  appStore.rows = 30;
  seedAgents(["qa", "design"]);
  appendRunOutput("qa", ["line one", "line two"]);

  const collapsed = render(<Dashboard />);
  const hCollapsed = frameHeight(collapsed.lastFrame());
  collapsed.unmount();

  toggleExpanded("qa");
  const expanded = render(<Dashboard />);
  const hExpanded = frameHeight(expanded.lastFrame());
  const frame = expanded.lastFrame() ?? "";
  expanded.unmount();

  assert.equal(hExpanded, hCollapsed, "expanding a pane must not grow the frame");
  assert.match(frame, /line two/); // pane actually shows output
});

test("render: expanded executor pane lists stuck work", () => {
  appStore.rows = 30;
  seedAgents(["implementer"], ["executor"]);
  poolStore.stuck = [{ identifier: "BRI-7", state: "fixing", reason: "verify failed" }];
  toggleExpanded("implementer");

  const { lastFrame, unmount } = render(<Dashboard />);
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /BRI-7/);
  assert.match(frame, /verify failed/);
});

test("render: feed interleaves engine and agent lines in arrival order", () => {
  appStore.rows = 30;
  seedAgents(["qa"]);
  appendEngineLines(["2026-07-28T10:00:00.000Z INFO loop started"]);
  appendAgentLines("qa", ["scanning routes"]);

  const { lastFrame, unmount } = render(<Dashboard />);
  const frame = lastFrame() ?? "";
  unmount();
  const loopAt = frame.indexOf("loop started");
  const scanAt = frame.indexOf("scanning routes");
  assert.ok(loopAt >= 0 && scanAt >= 0 && loopAt < scanAt);
});

test("render: loading splash shows boat, steps, and stays frame-pinned", () => {
  appStore.rows = 30;
  beginStep("mustering agents & connecting tracker");

  const { lastFrame, unmount } = render(<Loading />);
  const frame = lastFrame() ?? "";
  const h = frameHeight(lastFrame());
  unmount();
  assert.match(frame, /c {2}r {2}e {2}w/); // the boat hull
  assert.match(frame, /mustering agents/);
  assert.equal(h, 28, "splash must fill the same rows-2 frame as the dashboard");
});

test("render: error screen shows the failure", () => {
  appStore.rows = 30;
  failBoot("Linear API key rejected");
  const { lastFrame, unmount } = render(<ErrorScreen />);
  const frame = lastFrame() ?? "";
  unmount();
  assert.match(frame, /ran aground/);
  assert.match(frame, /Linear API key rejected/);
});

test("render: dashboard fills exactly rows-2", () => {
  appStore.rows = 26;
  seedAgents(["qa", "design"]);
  const { lastFrame, unmount } = render(<Dashboard />);
  const h = frameHeight(lastFrame());
  unmount();
  assert.equal(h, 24);
});
