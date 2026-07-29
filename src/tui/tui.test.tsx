// Tests are excluded from tsconfig (they never ship), so tsx transpiles this
// file's JSX with the classic runtime — the explicit React import is required
// here even though src files use the automatic runtime.
import React from "react";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { stripAnsi } from "../util/color.js";
import { keyToAction } from "./keys.js";
import {
  computeLayout,
  fmtElapsed,
  fmtUntil,
  sidebarWidth,
  windowStart,
  MIN_FEED,
  PANE_MIN,
  SIDEBAR_MAX_W,
  SIDEBAR_MIN_COLUMNS,
  SIDEBAR_W,
} from "./layout.js";
import { toSessions } from "../util/runindex.js";
import { dispatch } from "./actions.js";
import {
  historyStore,
  moveHistorySelection,
  resetHistoryStore,
  setSessions,
} from "./stores/history.js";
import { agentColor } from "./palette.js";
import {
  appStore,
  beginStep,
  endSteps,
  failBoot,
  focusHistory,
  focusNext,
  resetAppStore,
  toggleHistory,
} from "./stores/app.js";
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
  setKnownAgents,
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
  resetHistoryStore();
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
  assert.equal(engine!.source, null); // "executor" is not a known agent here
  assert.equal(raw!.level, null);
  assert.equal(agent!.source, "qa");
  assert.equal(agent!.origin, "run");

  appendEngineLines(Array.from({ length: MAX_FEED_LINES + 10 }, (_, i) => `x${i}`));
  assert.equal(feedStore.lines.length, MAX_FEED_LINES);
  // ids stay unique + monotonic after the splice
  const ids = feedStore.lines.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("feed store: engine lines with a known agent prefix are attributed to it", () => {
  setKnownAgents(["design", "qa"]);
  appendEngineLines([
    "2026-07-28T10:00:00.000Z INFO design: starting run (a headless agent analyzes the repo)…",
    "2026-07-28T10:00:01.000Z INFO design → Bash ls apps/web",
    "2026-07-28T10:00:02.000Z INFO qa finished",
    "2026-07-28T10:00:03.000Z INFO starting design (crew once design)", // mid-line ≠ attribution
    "2026-07-28T10:00:04.000Z INFO designer stopped", // prefix must be the WHOLE word
  ]);
  assert.deepEqual(
    feedStore.lines.map((l) => l.source),
    ["design", "design", "qa", null, null],
  );
  assert.ok(feedStore.lines.every((l) => l.origin === "engine"));
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

// Whether frames carry ANSI escapes depends on the environment (TTY,
// FORCE_COLOR/NO_COLOR) — under `npm publish` colors are ON and a regex like
// /backlog 12/ fails because "backlog " and "12" are separately styled
// segments with escapes between them. Strip escapes before every assertion so
// the tests pass identically in both modes.
const clean = (frame: string | undefined): string => stripAnsi(frame ?? "");
const frameHeight = (frame: string | undefined): number => clean(frame).split("\n").length;

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
  const frame = clean(lastFrame());
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
  const frame = clean(expanded.lastFrame());
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
  const frame = clean(lastFrame());
  unmount();
  assert.match(frame, /BRI-7/);
  assert.match(frame, /verify failed/);
});

test("render: feed interleaves engine and agent lines in arrival order", () => {
  appStore.rows = 30;
  seedAgents(["qa"]);
  setKnownAgents(["qa"]);
  appendEngineLines(["2026-07-28T10:00:00.000Z INFO loop started"]);
  appendEngineLines(["2026-07-28T10:00:00.000Z INFO qa: starting run"]);
  appendAgentLines("qa", ["scanning routes"]);

  const { lastFrame, unmount } = render(<Dashboard />);
  const frame = clean(lastFrame());
  unmount();
  const loopAt = frame.indexOf("loop started");
  const runAt = frame.indexOf("qa: starting run");
  const scanAt = frame.indexOf("scanning routes");
  assert.ok(loopAt >= 0 && runAt >= 0 && scanAt >= 0 && loopAt < runAt && runAt < scanAt);
});

test("render: loading splash shows boat, steps, and stays frame-pinned", () => {
  appStore.rows = 30;
  beginStep("mustering agents & connecting tracker");

  const { lastFrame, unmount } = render(<Loading />);
  const frame = clean(lastFrame());
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
  const frame = clean(lastFrame());
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

// ----------------------------- history sidebar -----------------------------

function seedSessions(): void {
  setSessions(
    toSessions([
      {
        id: "a.log",
        kind: "implement",
        at: "2026-07-28T10:00:00Z",
        agent: "implementer",
        item: "ENG-1",
        title: "Fix cache",
        outcome: "ok",
        prUrl: "https://github.com/x/y/pull/412",
        logPath: null,
      },
      {
        id: "b.log",
        kind: "verify",
        at: "2026-07-28T11:00:00Z",
        agent: "implementer",
        item: "ENG-2",
        title: "Add retries",
        outcome: "failed",
        reason: "2 failed, 41 passed",
        logPath: null,
      },
    ]),
  );
}

test("layout: sidebar appears only when wide enough, and grows within bounds", () => {
  // Below the threshold a sidebar would truncate the agent rows' padEnd cells.
  assert.equal(sidebarWidth(SIDEBAR_MIN_COLUMNS - 1, true), 0);
  assert.equal(sidebarWidth(80, true), 0);
  // Hidden is hidden, however wide the terminal is.
  assert.equal(sidebarWidth(300, false), 0);

  // At the threshold it takes the floor, and never less anywhere above it.
  assert.equal(sidebarWidth(SIDEBAR_MIN_COLUMNS, true), SIDEBAR_W);
  // It grows with the terminal — the content is text worth reading.
  assert.ok(sidebarWidth(160, true) > SIDEBAR_W);
  // …but stops, so a huge terminal doesn't starve the agent rows and feed.
  assert.equal(sidebarWidth(400, true), SIDEBAR_MAX_W);

  // The main column must stay wide enough for a full agent row at every size.
  for (const cols of [120, 140, 160, 200, 300, 400]) {
    assert.ok(cols - sidebarWidth(cols, true) >= 88, `main column too narrow at ${cols}`);
  }
});

test("keys: arrows move focus between panels, enter still expands", () => {
  assert.deepEqual(keyToAction("h", {}), { type: "toggle-history" });
  assert.deepEqual(keyToAction("", { tab: true }), { type: "focus-next" });
  assert.deepEqual(keyToAction("", { rightArrow: true }), { type: "focus-right" });
  assert.deepEqual(keyToAction("", { leftArrow: true }), { type: "focus-left" });
  assert.deepEqual(keyToAction("", { return: true }), { type: "toggle-expand" });
});

test("app store: sidebar starts visible and showing it never steals focus", () => {
  assert.equal(appStore.historyVisible, true, "the panel is a standing readout");
  assert.equal(appStore.focus, "agents", "focus starts on the agent list");

  focusHistory();
  assert.equal(appStore.focus, "history");

  focusNext();
  assert.equal(appStore.focus, "agents");

  toggleHistory();
  assert.equal(appStore.historyVisible, false);
  assert.equal(appStore.focus, "agents", "hiding must not leave focus on an invisible list");

  // Both focus gestures are inert while hidden — never focus something off-screen.
  focusNext();
  assert.equal(appStore.focus, "agents");
  focusHistory();
  assert.equal(appStore.focus, "agents");

  toggleHistory();
  assert.equal(appStore.historyVisible, true);
  assert.equal(appStore.focus, "agents", "re-showing leaves the cursor where it was");
});

test("history store: selection clamps and survives a shrinking list", () => {
  seedSessions();
  assert.equal(historyStore.sessions.length, 2);

  moveHistorySelection(-1);
  assert.equal(historyStore.selected, 0, "clamps at the top");
  moveHistorySelection(5);
  assert.equal(historyStore.selected, 1, "clamps at the bottom");

  // A poll that drops the list must pull the cursor back into range.
  setSessions([]);
  assert.equal(historyStore.selected, 0);
});

test("actions: → enters history, ↑↓ drive the focused list, ← comes back", () => {
  seedAgents(["qa", "design", "implementer"]);
  seedSessions();
  const noop = () => {};

  // Focused on agents: history must not move.
  dispatch({ type: "down" }, noop);
  assert.equal(agentsStore.selected, 1);
  assert.equal(historyStore.selected, 0);

  dispatch({ type: "focus-right" }, noop);
  assert.equal(appStore.focus, "history");

  dispatch({ type: "down" }, noop);
  assert.equal(historyStore.selected, 1, "history cursor moved");
  assert.equal(agentsStore.selected, 1, "agent cursor stayed put");

  // Enter is an agent gesture — in history it must not expand anything.
  dispatch({ type: "toggle-expand" }, noop);
  assert.deepEqual(agentsStore.expanded, {});

  dispatch({ type: "focus-left" }, noop);
  assert.equal(appStore.focus, "agents");
  dispatch({ type: "down" }, noop);
  assert.equal(agentsStore.selected, 2, "arrows drive agents again");
});

test("render: sidebar shows what runs produced without changing frame height", () => {
  appStore.rows = 30;
  appStore.columns = 160;
  seedAgents(["qa", "design"]);
  seedSessions();

  const with_ = render(<Dashboard />);
  const hWith = frameHeight(with_.lastFrame());
  const frame = clean(with_.lastFrame());
  with_.unmount();

  toggleHistory(); // hide it
  const without = render(<Dashboard />);
  const hWithout = frameHeight(without.lastFrame());
  const hiddenFrame = clean(without.lastFrame());
  without.unmount();

  assert.equal(hWith, hWithout, "the sidebar is a width split — it must not add rows");
  assert.match(frame, /RECENT/);
  assert.match(frame, /ENG-1/);
  assert.match(frame, /ENG-2/);
  // The OUTCOMES are the point, not the fact that a run happened.
  // A narrow sidebar truncates the url, so assert the marker + host rather
  // than the full link — the point is that it's THERE without opening a log.
  assert.match(frame, /⎇ https:\/\/github\.com/, "a created PR must be visible inline");
  assert.match(frame, /2 failed/, "the verify failure must be visible inline");
  assert.match(frame, /qa/, "agent rows still render alongside it");
  assert.doesNotMatch(hiddenFrame, /RECENT/, "h hides the panel");
});

test("render: proposer sessions show the tickets they filed", () => {
  appStore.rows = 30;
  appStore.columns = 160;
  seedAgents(["qa"]);
  setSessions(
    toSessions([
      {
        id: "p.log",
        kind: "propose",
        at: "2026-07-28T12:00:00Z",
        agent: "qa",
        outcome: "ok",
        created: ["ENG-7", "ENG-8"],
        logPath: null,
      },
    ]),
  );

  const { lastFrame, unmount } = render(<Dashboard />);
  const frame = clean(lastFrame());
  unmount();

  assert.match(frame, /ENG-7/);
  assert.match(frame, /ENG-8/);
});

test("render: long titles and urls truncate exactly once", () => {
  appStore.rows = 30;
  appStore.columns = 160;
  seedAgents(["qa"]);
  setSessions(
    toSessions([
      {
        id: "1.log",
        kind: "implement",
        at: "2026-07-28T10:00:00Z",
        agent: "implementer",
        item: "ENG-1",
        title: "A title far too long to fit inside the sidebar column",
        outcome: "ok",
        prUrl: "https://github.com/acme/very-long-repo-name/pull/41234",
        logPath: null,
      },
    ]),
  );

  const { lastFrame, unmount } = render(<Dashboard />);
  const frame = clean(lastFrame());
  unmount();

  const head = frame.split("\n").find((l) => l.includes("ENG-1"))!;
  assert.ok(head, "expected the session header to render");
  // Over-reserving row chrome makes Ink truncate a second time.
  assert.doesNotMatch(head, /……/, "the header must truncate exactly once");
  assert.match(head, /…/, "a too-long title must be truncated");

  const pr = frame.split("\n").find((l) => l.includes("github.com"))!;
  assert.ok(pr, "the PR url gets its own line");
  assert.doesNotMatch(pr, /……/, "the url must truncate exactly once");
});

test("render: focus and sidebar changes never grow or duplicate the frame", () => {
  // The incrementalRendering contract: the frame must never grow between
  // paints, and no section header or footer may appear twice. A nested
  // flexGrow row breaks this — its height follows its tallest child, so a
  // taller sidebar re-anchors Ink's line diff and the chrome duplicates.
  appStore.rows = 40;
  appStore.columns = 200;
  seedAgents(["architect", "design", "product", "qa", "implementer"]);
  appendEngineLines(
    Array.from({ length: 60 }, (_, i) => `2026-07-29T14:00:00Z INFO engine line ${i}`),
  );
  seedSessions();

  const seen = new Set<number>();
  const shot = (tag: string, frame?: string) => {
    const rows = clean(frame).split("\n");
    seen.add(rows.length);
    assert.equal(rows.filter((l) => l.includes("AGENTS")).length, 1, `${tag}: one AGENTS header`);
    assert.equal(rows.filter((l) => l.includes("RECENT")).length, 1, `${tag}: one RECENT header`);
    assert.equal(rows.filter((l) => l.includes("q quit")).length, 1, `${tag}: one footer`);
  };

  const { lastFrame, rerender, unmount } = render(<Dashboard />);
  shot("initial", lastFrame());

  focusHistory();
  rerender(<Dashboard />);
  shot("focused history", lastFrame());

  // A much taller sidebar than the agent list — the case that broke.
  setSessions(
    toSessions(
      Array.from({ length: 30 }, (_, i) => ({
        id: `${i}.log`,
        kind: "implement" as const,
        at: new Date(Date.parse("2026-07-29T10:00:00Z") - i * 60_000).toISOString(),
        agent: "implementer",
        item: `ENG-${i}`,
        title: `Task ${i}`,
        outcome: (i % 2 ? "failed" : "ok") as "failed" | "ok",
        reason: i % 2 ? "2 failed, 41 passed" : undefined,
        logPath: null,
      })),
    ),
  );
  rerender(<Dashboard />);
  shot("sidebar grew", lastFrame());

  moveHistorySelection(6);
  rerender(<Dashboard />);
  shot("scrolled history", lastFrame());

  appStore.focus = "agents";
  rerender(<Dashboard />);
  shot("back to agents", lastFrame());
  unmount();

  assert.equal(seen.size, 1, `frame height must never change, saw ${[...seen].join(", ")}`);
});

test("render: sidebar stays hidden on a narrow terminal", () => {
  appStore.rows = 30;
  appStore.columns = 80;
  seedAgents(["qa"]);
  seedSessions();

  const { lastFrame, unmount } = render(<Dashboard />);
  const frame = clean(lastFrame());
  unmount();

  assert.doesNotMatch(frame, /RECENT/);
  assert.match(frame, /qa/, "the agent list keeps its full width");
});
