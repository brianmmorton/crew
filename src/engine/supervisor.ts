import { Cron } from "croner";
import readline from "node:readline";
import type { CrewConfig, Logger, PersonaName } from "../types.js";
import type { Ports } from "./ports.js";
import { proposerCycle } from "./cycles.js";
import { runExecutorLoop, requestStop, wakeExecutor, setPaused } from "./loop.js";
import { killActiveRuns } from "../personas/runner.js";
import { readState, writeState } from "../util/state.js";
import { scheduledAgents } from "../agent/agents.js";

export interface RunOptions {
  /** Schedule the proposer personas on their cadence (default true). */
  proposers: boolean;
  /** Force-run every enabled proposer once at startup, regardless of last run. */
  kickoff: boolean;
}

/**
 * A hotkey action: one of the fixed controls, or `{ run: <agent> }` to fire a
 * scheduled agent now. Agent keys are assigned dynamically at startup, so
 * custom agents get hotkeys too.
 */
export type HotAction =
  | "impl"
  | "pause"
  | "status"
  | "kill"
  | "quit"
  | { run: PersonaName }
  | null;

/** Keys the fixed controls own; agents can never be assigned these. */
const RESERVED = new Set(["i", "p", "s", "k", "c"]);

/**
 * Assign a hotkey to each scheduled agent: its first unused letter, else a
 * digit. Deterministic given the same ordered list, so the legend is stable
 * across restarts.
 */
export function assignKeys(names: PersonaName[]): Map<string, PersonaName> {
  const map = new Map<string, PersonaName>();
  const taken = new Set(RESERVED);
  const leftovers: PersonaName[] = [];

  for (const name of names) {
    const letter = [...name.toLowerCase()].find(
      (ch) => /[a-z]/.test(ch) && !taken.has(ch),
    );
    if (letter) {
      taken.add(letter);
      map.set(letter, name);
    } else {
      leftovers.push(name);
    }
  }
  // Anything that couldn't get a letter falls back to 1-9.
  let digit = 1;
  for (const name of leftovers) {
    if (digit > 9) break;
    map.set(String(digit++), name);
  }
  return map;
}

/** Map a keypress to an action. Pure, for testability. */
export function keyToAction(
  name: string | undefined,
  ctrl: boolean,
  keys: Map<string, PersonaName> = new Map(),
): HotAction {
  if (ctrl && name === "c") return "quit";
  if (!name) return null;
  switch (name) {
    case "i":
      return "impl";
    case "p":
      return "pause";
    case "s":
      return "status";
    case "k":
      return "kill";
    default: {
      const agent = keys.get(name);
      return agent ? { run: agent } : null;
    }
  }
}

/** Gap (ms) between the next two scheduled fires; Infinity if not schedulable. */
export function scheduleInterval(cadence: string): number {
  try {
    const c = new Cron(cadence, { paused: true });
    const n1 = c.nextRun();
    const n2 = n1 ? c.nextRun(n1) : null;
    c.stop();
    if (!n1 || !n2) return Infinity;
    return n2.getTime() - n1.getTime();
  } catch {
    return Infinity;
  }
}

/**
 * Should a proposer run immediately on startup? True if it never ran, or a full
 * scheduling interval has elapsed since it last ran (i.e. we missed a tick while
 * down). This gives instant first-run activity without re-flooding on quick
 * launchd restarts.
 */
export function dueOnStartup(
  cadence: string,
  lastRunISO: string | undefined,
  now = Date.now(),
): boolean {
  if (!lastRunISO) return true;
  const t = Date.parse(lastRunISO);
  if (Number.isNaN(t)) return true;
  return now - t >= scheduleInterval(cadence);
}

/** Build the control legend from the dynamically-assigned agent keys. */
export function buildLegend(keys: Map<string, PersonaName>): string {
  const agents = [...keys.entries()].map(([k, n]) => `[${k}]${n}`).join("  ");
  return `${agents}${agents ? "  " : ""}[i]impl-now  [k]kill-run  [p]pause  [s]status  [Ctrl-C]quit`;
}

/**
 * Run the whole team in one process: the continuous executor loop plus proposers
 * on their cron cadence. When attached to a TTY, single-key hotkeys let you
 * trigger any persona now, pause/resume, print status, or quit.
 */
export async function runSupervised(
  cfg: CrewConfig,
  ports: Ports,
  logger: Logger,
  opts: RunOptions,
): Promise<void> {
  const jobs: Cron[] = [];
  const busy = new Set<PersonaName>();
  let teamPaused = false;

  const state = readState(cfg.configDir);
  state.pid = process.pid;
  state.startedAt = new Date().toISOString();
  writeState(cfg.configDir, state);

  // Every agent with a cron cadence — built-in or user-defined. Reviewers are
  // driven by the executor cycle, not scheduled, so they're excluded here.
  const scheduled = scheduledAgents(Object.values(ports.agents))
    .filter((a) => a.kind === "proposer")
    .sort((a, b) => a.name.localeCompare(b.name));
  const keys = assignKeys(scheduled.map((a) => a.name));

  const runProposerSafe = async (
    name: PersonaName,
    manual = false,
  ): Promise<void> => {
    if (teamPaused && !manual) return;
    if (!ports.agents[name]) {
      logger.warn(`${name}: not enabled (no personas/${name}.md); ignoring`);
      return;
    }
    if (busy.has(name)) {
      logger.info(`${name}: previous run still going; skipping`);
      return;
    }
    busy.add(name);
    try {
      const out = await proposerCycle(cfg, ports, name, logger);
      logger.info(`${name} finished`, { status: out.status, filed: out.created?.length ?? 0 });
      state.lastRun[name] = new Date().toISOString();
      writeState(cfg.configDir, state);
    } catch (e) {
      logger.error(`${name} run failed`, { error: String(e) });
    } finally {
      busy.delete(name);
    }
  };

  // --- schedule proposers -----------------------------------------------------
  if (opts.proposers) {
    for (const a of scheduled) {
      let job: Cron;
      try {
        job = new Cron(a.cadence, { name: a.name, protect: true }, () =>
          runProposerSafe(a.name),
        );
      } catch (e) {
        logger.error(`${a.name}: invalid cadence "${a.cadence}"; not scheduled`, {
          error: String(e),
        });
        continue;
      }
      jobs.push(job);
      logger.info(`scheduled ${a.name}`, {
        cadence: a.cadence,
        next: job.nextRun()?.toISOString() ?? null,
      });
    }
    if (jobs.length === 0) logger.warn("no proposers scheduled (none enabled with a cadence)");
  } else {
    logger.info("proposers disabled (--no-proposers); executor only");
  }

  // --- shutdown ---------------------------------------------------------------
  let down = false;
  const shutdown = (sig: string): void => {
    if (down) return;
    down = true;
    logger.info(`${sig}; stopping after current work`);
    for (const j of jobs) j.stop();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      process.stdin.pause();
    }
    requestStop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // --- action handler ---------------------------------------------------------
  const printStatus = async (): Promise<void> => {
    const [backlog, inProgress] = await Promise.all([
      ports.linear.countBacklog(),
      ports.linear.countInProgress(),
    ]);
    logger.info(
      `status: backlog=${backlog} inProgress=${inProgress}/${cfg.gates.wipCap} ` +
        `paused=${teamPaused}`,
    );
    for (const j of jobs) {
      logger.info(`  ${j.name}: next ${j.nextRun()?.toLocaleString() ?? "—"}`);
    }
  };

  const onAction = (a: HotAction): void => {
    if (a && typeof a === "object") {
      logger.info(`hotkey: run ${a.run} now`);
      void runProposerSafe(a.run, true);
      return;
    }
    switch (a) {
      case "impl":
        logger.info("hotkey: nudging executor to check for work now");
        wakeExecutor();
        break;
      case "pause":
        teamPaused = !teamPaused;
        setPaused(teamPaused);
        for (const j of jobs) (teamPaused ? j.pause() : j.resume());
        logger.info(teamPaused ? "PAUSED (executor + proposers)" : "RESUMED");
        if (!teamPaused) wakeExecutor();
        break;
      case "status":
        void printStatus();
        break;
      case "kill": {
        const n = killActiveRuns();
        logger.warn(`hotkey: killed ${n} running agent${n === 1 ? "" : "s"}`);
        break;
      }
      case "quit":
        shutdown("quit");
        break;
      default:
        break;
    }
  };

  // --- hotkeys (TTY only) -----------------------------------------------------
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
    process.stdin.on("keypress", (_s: string, key: { name?: string; ctrl?: boolean } | undefined) => {
      if (!key) return;
      onAction(keyToAction(key.name, !!key.ctrl, keys));
    });
    logger.info(`controls: ${buildLegend(keys)}`);
  } else {
    logger.info("no TTY detected; hotkeys disabled (running headless)");
  }

  // --- immediate first pass (catch-up) ---------------------------------------
  if (opts.proposers) {
    for (const a of scheduled) {
      if (opts.kickoff || dueOnStartup(a.cadence, state.lastRun[a.name])) {
        logger.info(`startup: running ${a.name} now (${opts.kickoff ? "kickoff" : "catch-up"})`);
        void runProposerSafe(a.name, true);
      }
    }
  }

  // --- run the executor (blocks until stopped) --------------------------------
  await runExecutorLoop(cfg, ports, logger);
  for (const j of jobs) j.stop();
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  }
}
