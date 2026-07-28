import React, { useEffect } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useSnapshot } from "valtio";
import type { CrewConfig } from "../types.js";
import {
  takeSnapshot,
  fetchTrackerCounts,
  LogTail,
  type Snapshot,
  type TrackerCounts,
} from "./snapshot.js";
import { RunManager } from "./runManager.js";
import { Header } from "./Header.js";
import { AgentList } from "./AgentList.js";
import { LogPanel } from "./LogPanel.js";
import { InFlight } from "./InFlight.js";
import { RunView } from "./RunView.js";
import { LoadingSplash } from "./Spinner.js";
import { fetchLogoArt } from "./logoArt.js";
import { buildPorts, type Ports } from "../engine/ports.js";
import { runExecutorLoop, setPaused, wakeExecutor, requestStop, resetStop } from "../engine/loop.js";
import { logger, logToFile, logFilePath } from "../util/logger.js";
import {
  store,
  appendLogLines,
  publishSnapshot,
  takeTrackerDirty,
  invalidateTrackerCounts,
} from "./store.js";

/** Local-only refresh: log tail, worktree pool, claims. Cheap, no network. */
const POLL_MS = 1000;

/**
 * Ceiling on how stale the tracker counts may get. Between refreshes they're
 * served from cache; `invalidateTrackerCounts()` pulls one forward when local
 * state shows work actually moved, so this is a backstop rather than the
 * primary trigger.
 */
const COUNTS_MAX_AGE_MS = 60_000;

const runManager = new RunManager();

/**
 * Everything the TUI runs in the background: the real executor loop (same
 * code path as `crew run`, so the implementer keeps draining the backlog
 * with `budget.implementerWorkers` concurrent workers rather than the
 * one-shot `crew once` a manual run gives), the snapshot poller, and the
 * logo fetch.
 *
 * Started exactly once per process from a module-level singleton rather
 * than a useEffect. An effect keyed on `cfg` would tear the executor down
 * and restart it on any re-render that changed the cfg identity — which
 * showed up as "crew executor loop started/stopped" cycling in the log and
 * repeated loading splashes on screen.
 *
 * Ports are built once and reused by the poller: buildPorts does a tracker
 * resolveMeta() network call plus forge/agent I/O, too expensive to redo
 * every second. They're held here, not in the valtio store — nothing
 * renders from them, and proxying them would wrap every adapter call.
 */
let started = false;
let ports: Ports | null = null;


function startBackground(cfg: CrewConfig): void {
  if (started) return;
  started = true;

  logToFile(logFilePath(cfg.configDir));

  const url = cfg.ui.logoUrl;
  if (url) {
    void fetchLogoArt(url, 24, 6).then((art) => {
      store.headerLogo = art;
    });
    void fetchLogoArt(url, 60, 16).then((art) => {
      store.splashLogo = art;
    });
  }

  let warnedDoubleRun = false;

  // Tracker counts are the only network I/O on the snapshot path, so they get
  // their own cadence and are cached between local ticks. Polling them once a
  // second is what exhausted a Linear quota (3M complexity points/hour); the
  // counts also simply don't change that fast.
  let counts: TrackerCounts = { backlog: 0, inProgress: 0 };
  let countsAt = 0;
  let countsInFlight = false;

  // Previous tick's local signals, for spotting the moment work moved.
  let lastBusySlots = -1;
  let lastClaimCount = -1;

  async function refreshCounts(): Promise<void> {
    if (!ports || countsInFlight) return;
    countsInFlight = true;
    try {
      counts = await fetchTrackerCounts(ports);
      countsAt = Date.now();
    } catch (e) {
      // A failed count must not blank the dashboard — keep the last good
      // numbers and let the next attempt sort it out.
      logger.warn(`tracker counts failed: ${e instanceof Error ? e.message : String(e)}`);
      countsAt = Date.now();
    } finally {
      countsInFlight = false;
    }
  }

  /** Local-only tick: log tail, worktree pool, claims, agent schedule. */
  async function tick() {
    if (!ports) return;

    // The tracker is re-read when the counts are stale, or when the local
    // state says the picture just changed — a worktree slot freeing up or a
    // claim being released means an item moved, which is exactly when the
    // backlog/wip numbers are worth refetching.
    const stale = Date.now() - countsAt >= COUNTS_MAX_AGE_MS;
    if (stale || takeTrackerDirty()) void refreshCounts();

    const next = await takeSnapshot(cfg, ports, counts);

    // Both of these are local reads, and both mean an item just moved between
    // states — so they're a far better signal to refetch on than a timer.
    // Checked after the snapshot so the *next* tick picks the counts up.
    const busyNow = next.slots?.filter((s) => s.state === "busy").length ?? 0;
    const claimsNow = next.stuck.length;
    if (busyNow !== lastBusySlots || claimsNow !== lastClaimCount) {
      lastBusySlots = busyNow;
      lastClaimCount = claimsNow;
      invalidateTrackerCounts();
    }

    // Skips the write when nothing visible moved, so an idle TUI stops
    // re-rendering the dashboard once a second.
    publishSnapshot(next);
    appendLogLines(new LogTail(next.logPath).read());

    if (next.supervisorAlive && !warnedDoubleRun) {
      warnedDoubleRun = true;
      logger.warn(
        "a `crew run` supervisor already appears to be running (see header); this TUI is " +
          "also running its own implementer loop, so both will be draining the backlog",
      );
    }
  }

  void (async () => {
    try {
      ports = await buildPorts(cfg);
    } catch (e) {
      store.snap = {
        ...(store.snap ?? ({} as Snapshot)),
        error: e instanceof Error ? e.message : String(e),
      } as Snapshot;
      return;
    }
    resetStop();
    setPaused(false);
    await refreshCounts();
    void tick();
    setInterval(tick, POLL_MS);
    await runExecutorLoop(cfg, ports, logger);
  })();
}


/** Stops the executor loop and any live agent runs. Called once on unmount. */
function stopBackground(): void {
  requestStop();
  runManager.stopAll();
}

/** Thin shell: bootstraps background effects and routes input, but never subscribes to store itself — only leaf components (Header/AgentList/LogPanel/Dashboard) re-render on store changes. */
export function App({ cfg }: { cfg: CrewConfig }) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  useEffect(() => {
    startBackground(cfg);
    return stopBackground;
  }, []);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      store.rows = stdout.rows;
    };
    onResize(); // seed from the real terminal, not the store's 24-row default
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useInput((input, key) => {
    if (store.expanded) {
      if (key.escape) store.expanded = null;
      else if (input === "k") runManager.stop(store.expanded);
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    if (input === "p") {
      const next = !store.implPaused;
      store.implPaused = next;
      setPaused(next);
      if (!next) wakeExecutor();
      logger.info(next ? "implementer paused" : "implementer resumed");
      return;
    }
    const agentRows = store.snap?.agentRows ?? [];
    if (key.upArrow) store.selected = Math.max(0, store.selected - 1);
    else if (key.downArrow) store.selected = Math.min(agentRows.length - 1, store.selected + 1);
    else if (key.return || input === " ") {
      const row = agentRows[store.selected];
      if (!row || row.agent.kind === "reviewer" || row.agent.kind === "executor") return;
      runManager.start(row.agent.name);
      store.expanded = row.agent.name;
    }
  });

  return <Screen implWorkers={cfg.budget.implementerWorkers ?? 1} />;
}

/**
 * Owns the expanded/loading/error/dashboard routing and the layout math
 * (logHeight/reserved) that depends on live snap/rows data — the one place
 * that legitimately needs to read most of the store, so it's isolated here
 * rather than in App, keeping App itself free of store subscriptions.
 */
export function Screen({ implWorkers }: { implWorkers: number }) {
  const snap = useSnapshot(store);

  // Only `expanded` with a live run shows the run view. A stale name (run
  // never started) just falls through to the dashboard — clearing it here
  // would be a store mutation during render, which re-enters the renderer
  // and tears the frame.
  if (snap.expanded && snap.runs.has(snap.expanded)) {
    return <RunView agent={snap.expanded} height={Math.max(4, snap.rows - 6)} />;
  }

  if (!snap.snap) {
    return (
      <Box marginTop={1}>
        <LoadingSplash label="reading agents, tracker, and worktree pool…" logoArt={snap.splashLogo} />
      </Box>
    );
  }

  if (snap.snap.error) {
    return (
      <Box flexDirection="column">
        <Text color="red">crew tui: {snap.snap.error}</Text>
      </Box>
    );
  }

  const agentRows = snap.snap.agentRows;

  // Budget the frame against the real terminal height. A frame taller than
  // the window scrolls its own top off screen, which reads as the UI
  // duplicating itself — so nothing here gets a lower clamp that could push
  // past `rows`. Sections claim space in priority order:
  //   header      2 rows (+1 with mcp oauth) + 1 trailing blank   — fixed
  //   footer      1 blank + 1 hint line                           — fixed
  //   in flight   1 blank + 1 label + one row per item            — first claim
  //   agents      1 "AGENTS" label + one row per agent            — then truncates
  //   log panel   1 blank + 1 "LOG" label + N lines               — flexes, then drops
  //
  // In-flight comes before agents: it's the section that says something is
  // wrong right now (an abandoned claim, a retry loop), while the agent list
  // is near-static. On a short window the stuck work is what you need to see.
  const headerLines = 3 + (snap.snap.mcpOAuth.length > 0 ? 1 : 0);
  const footerLines = 2;
  let budget = snap.rows - headerLines - footerLines;

  const maxStuck = Math.max(0, budget - 2);
  const visibleStuck = Math.min(snap.snap.stuck.length, maxStuck);
  budget -= visibleStuck > 0 ? 2 + visibleStuck : 0;

  const maxAgentRows = Math.max(0, budget - 1);
  const visibleAgents = Math.min(agentRows.length, maxAgentRows);
  // Dropped rather than shown empty: a label over "(none found)" costs two
  // lines to say nothing, and on a window this short those two lines are the
  // difference between fitting and scrolling the frame off screen.
  const showAgents = visibleAgents > 0;
  budget -= showAgents ? 1 + visibleAgents : 0;

  // Whatever is left goes to the log; below one usable line it's dropped.
  const logHeight = budget - 2;
  const showLog = logHeight >= 1;

  return (
    <Box flexDirection="column">
      <Header />
      {showAgents && <AgentList implWorkers={implWorkers} maxRows={visibleAgents} />}
      {showLog && (
        <Box marginTop={1}>
          <LogPanel height={logHeight} />
        </Box>
      )}
      <InFlight items={snap.snap.stuck.slice(0, visibleStuck)} total={snap.snap.stuck.length} />
      <Box marginTop={1}>
        <Text dimColor>
          [↑↓] select  [enter] run / view  [p] pause/resume implementer  [q] quit
        </Text>
      </Box>
    </Box>
  );
}
