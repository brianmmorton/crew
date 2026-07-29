import { Cron } from "croner";
import type { CrewConfig } from "../types.js";
import { agentsOfKind, scheduledAgents } from "../agent/agents.js";
import { buildPorts, type Ports } from "../engine/ports.js";
import { requestStop, resetStop, runExecutorLoop, setPaused } from "../engine/loop.js";
import { poolStatus, worktreeRootFor } from "../git/pool.js";
import { stuckItems } from "../engine/stuck.js";
import { hasStoredToken } from "../config/oauth.js";
import { readState } from "../util/state.js";
import { logFilePath, logToFile, logger } from "../util/logger.js";
import { LogTail } from "./logTail.js";
import { stopAllRuns } from "./runManager.js";
import { appStore, beginStep, endSteps, failBoot } from "./stores/app.js";
import { setAgents, type AgentItem } from "./stores/agents.js";
import { appendEngineLines } from "./stores/feed.js";
import { mcpStore, type McpStatus } from "./stores/mcp.js";
import { poolStore, takeTrackerDirty, type SlotView, type StuckView } from "./stores/pool.js";
import { tickClock } from "./stores/clock.js";
import { trace } from "./debug.js";

/**
 * Everything that runs BEHIND the React tree: building ports, the executor
 * loop, and the 1s poll that feeds the stores. Module-level singleton — React
 * StrictMode/remounts must not spawn a second executor loop or poll timer.
 *
 * The stores are the only bridge to the UI. Nothing here holds React state,
 * and no component imports engine modules directly.
 */

const POLL_MS = 1000;
/**
 * Tracker counts are the only network reads on the poll path, and polling
 * them at 1s once exhausted a Linear API quota. They refresh on their own
 * slow cadence — or immediately when local state says work moved
 * (takeTrackerDirty). Do not regress this.
 */
const COUNTS_MAX_AGE_MS = 60_000;
/** Splash minimum, so the boot animation reads as a moment, not a flicker. */
const SPLASH_MIN_MS = 900;

let started = false;
let timer: NodeJS.Timeout | null = null;
let tail: LogTail | null = null;
let ports: Ports | null = null;
let cfgRef: CrewConfig | null = null;
let countsAt = 0;
let countsInFlight = false;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startBackground(cfg: CrewConfig): Promise<void> {
  if (started) return;
  started = true;
  cfgRef = cfg;
  appStore.project = cfg.project;
  const t0 = Date.now();

  // Log lines keep flowing to the file while the TUI owns the screen; the
  // OUTPUT panel tails that same file back in.
  logToFile(logFilePath(cfg.configDir));

  try {
    beginStep("reading the crew manifest");
    poolStore.workers = Math.max(1, cfg.budget.implementerWorkers ?? 1);
    poolStore.wipCap = cfg.gates.wipCap;

    beginStep("mustering agents & connecting tracker");
    ports = await buildPorts(cfg);
    setAgents(buildAgentItems(ports));

    beginStep("checking MCP moorings");
    publishMcp(cfg, ports);

    beginStep("surveying the board");
    await refreshCounts();
    endSteps(true);
  } catch (e) {
    failBoot(e instanceof Error ? e.message : String(e));
    return;
  }

  // Seed the feed with recent history so the panel isn't empty at first paint.
  tail = new LogTail(logFilePath(cfg.configDir));
  appendEngineLines(tail.read());
  pollLocal();

  timer = setInterval(tick, POLL_MS);

  // Let the splash land before switching screens.
  await sleep(Math.max(0, SPLASH_MIN_MS - (Date.now() - t0)));
  appStore.phase = "ready";

  // The executor loop runs for the life of the TUI; requestStop() (see
  // stopBackground) is what drains it. A crash surfaces in the feed, not as
  // an unhandled rejection tearing the screen down.
  resetStop();
  setPaused(false);
  logger.info("crew tui started");
  void runExecutorLoop(cfg, ports, logger).catch((err) => {
    logger.error("executor loop crashed", { error: String(err) });
  });
}

export function stopBackground(): void {
  if (!started) return;
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
  requestStop();
  stopAllRuns();
  tail = null;
  ports = null;
  cfgRef = null;
  countsAt = 0;
}

export function getPorts(): Ports | null {
  return ports;
}

// ----------------------------- the poll tick -------------------------------

function tick(): void {
  tickClock();
  const newLines = tail?.read() ?? [];
  appendEngineLines(newLines);
  pollLocal();

  const stale = Date.now() - countsAt > COUNTS_MAX_AGE_MS;
  if ((stale || takeTrackerDirty()) && !countsInFlight) {
    void refreshCounts().catch((e) => {
      trace("counts-error", () => String(e));
    });
  }
}

/** Cheap local reads: worktree slots, stuck items, supervisor pid, MCP, cron. */
function pollLocal(): void {
  const cfg = cfgRef;
  if (!cfg || !ports) return;
  try {
    setIfChanged(poolStore, "slots", readSlots(cfg));
    setIfChanged(poolStore, "stuck", readStuck(cfg));
    setIfChanged(poolStore, "supervisorAlive", pidAlive(readState(cfg.configDir).pid));
    publishMcp(cfg, ports);
    setAgentsIfChanged(buildAgentItems(ports));
  } catch (e) {
    // A bad poll tick must never take the screen down.
    trace("poll-error", () => String(e));
  }
}

async function refreshCounts(): Promise<void> {
  if (!ports) return;
  countsInFlight = true;
  try {
    const [backlog, inProgress] = await Promise.all([
      ports.tracker.countBacklog(),
      ports.tracker.countInProgress(),
    ]);
    countsAt = Date.now();
    setIfChanged(poolStore, "backlog", backlog);
    setIfChanged(poolStore, "inProgress", inProgress);
  } finally {
    countsInFlight = false;
  }
}

// ----------------------------- gatherers -----------------------------------

/**
 * Panel order: scheduled agents first (they have a "next" worth reading),
 * then executors, then reviewers — deduped by name so a reviewer WITH a
 * cadence doesn't appear twice.
 */
function buildAgentItems(p: Ports): AgentItem[] {
  const all = Object.values(p.agents).sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set<string>();
  const rows: AgentItem[] = [];
  const push = (def: (typeof all)[number], nextRun: number | null) => {
    if (seen.has(def.name)) return;
    seen.add(def.name);
    rows.push({
      name: def.name,
      kind: def.kind,
      cadence: def.cadence,
      description: def.description,
      nextRun,
    });
  };
  for (const def of scheduledAgents(all)) push(def, nextRunFor(def.cadence));
  for (const def of agentsOfKind(all, "executor")) push(def, null);
  for (const def of agentsOfKind(all, "reviewer")) push(def, null);
  return rows;
}

function nextRunFor(cadence: string): number | null {
  try {
    const c = new Cron(cadence, { paused: true });
    const n = c.nextRun();
    c.stop();
    return n ? n.getTime() : null;
  } catch {
    return null;
  }
}

function readSlots(cfg: CrewConfig): SlotView[] | null {
  if (!cfg.worktrees.reuse) return null;
  return poolStatus(worktreeRootFor(cfg.repo.path), cfg.worktrees.max).map((s) => ({
    slot: s.slot,
    state: s.state,
    branch: s.branch,
  }));
}

function readStuck(cfg: CrewConfig): StuckView[] {
  return stuckItems(cfg).map((s) => ({
    identifier: s.identifier,
    state: s.state,
    reason: s.reason,
  }));
}

/** Servers granted to at least one agent, with OAuth login state where it exists. */
function publishMcp(cfg: CrewConfig, p: Ports): void {
  const servers = cfg.mcpServers ?? {};
  const granted = new Set(Object.values(p.agents).flatMap((a) => a.mcp ?? []));
  const rows: McpStatus[] = [...granted]
    .filter((name) => servers[name])
    .sort()
    .map((server) => {
      const oauth = Boolean(servers[server]?.oauth);
      return { server, oauth, loggedIn: oauth ? hasStoredToken(server) : null };
    });
  if (JSON.stringify(rows) !== JSON.stringify(mcpStore.servers)) mcpStore.servers = rows;
}

// ----------------------------- helpers -------------------------------------

/** Same liveness check the claim lock uses: signal 0. */
function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Write a store field only when its value actually changed. The poller
 * rebuilds these values every second; unconditional assignment would hand
 * valtio a fresh reference each tick and re-render subscribers for nothing.
 */
function setIfChanged<T extends object, K extends keyof T>(store: T, key: K, next: T[K]): void {
  if (JSON.stringify(store[key]) === JSON.stringify(next)) return;
  store[key] = next;
}

let lastAgentsShape = "";
function setAgentsIfChanged(items: AgentItem[]): void {
  // nextRun changes every cron minute at most; round to the minute so the
  // shape compare doesn't churn on millisecond drift.
  const shape = JSON.stringify(
    items.map((a) => [a.name, a.kind, a.nextRun && Math.floor(a.nextRun / 60_000)]),
  );
  if (shape === lastAgentsShape) return;
  lastAgentsShape = shape;
  setAgents(items);
}
