import { Cron } from "croner";
import readline from "node:readline";
import type { CrewConfig, Logger, PersonaName } from "../types.js";
import type { Ports } from "./ports.js";
import { proposerCycle } from "./cycles.js";
import { runExecutorLoop, requestStop, wakeExecutor, setPaused } from "./loop.js";
import { killActiveRuns } from "../personas/runner.js";
import { readState, writeState } from "../util/state.js";

export interface RunOptions {
  /** Schedule the proposer personas on their cadence (default true). */
  proposers: boolean;
  /** Force-run every enabled proposer once at startup, regardless of last run. */
  kickoff: boolean;
}

export type HotAction =
  | "qa"
  | "design"
  | "architect"
  | "impl"
  | "pause"
  | "status"
  | "kill"
  | "quit"
  | null;

const PROPOSERS: PersonaName[] = ["qa", "design", "architect"];

/** Map a keypress to an action. Pure, for testability. */
export function keyToAction(name: string | undefined, ctrl: boolean): HotAction {
  if (ctrl && name === "c") return "quit";
  switch (name) {
    case "q":
      return "qa";
    case "d":
      return "design";
    case "a":
      return "architect";
    case "i":
      return "impl";
    case "p":
      return "pause";
    case "s":
      return "status";
    case "k":
      return "kill";
    default:
      return null;
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

const LEGEND =
  "[q]QA  [d]Design  [a]Architect  [i]impl-now  [k]kill-run  [p]pause  [s]status  [Ctrl-C]quit";

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

  const isEnabled = (name: PersonaName): boolean => {
    const p = cfg.personas[name];
    return !!p && !!ports.prompts[name] && !!p.cadence && p.cadence !== "continuous";
  };

  const runProposerSafe = async (
    name: PersonaName,
    manual = false,
  ): Promise<void> => {
    if (teamPaused && !manual) return;
    if (!ports.prompts[name]) {
      logger.warn(`${name}: not enabled (no prompt); ignoring`);
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
    for (const name of PROPOSERS) {
      if (!isEnabled(name)) continue;
      const cadence = cfg.personas[name]!.cadence;
      const job = new Cron(cadence, { name, protect: true }, () => runProposerSafe(name));
      jobs.push(job);
      logger.info(`scheduled ${name}`, {
        cadence,
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
    switch (a) {
      case "qa":
      case "design":
      case "architect":
        logger.info(`hotkey: run ${a} now`);
        void runProposerSafe(a, true);
        break;
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
      onAction(keyToAction(key.name, !!key.ctrl));
    });
    logger.info(`controls: ${LEGEND}`);
  } else {
    logger.info("no TTY detected; hotkeys disabled (running headless)");
  }

  // --- immediate first pass (catch-up) ---------------------------------------
  if (opts.proposers) {
    for (const name of PROPOSERS) {
      if (!isEnabled(name)) continue;
      if (opts.kickoff || dueOnStartup(cfg.personas[name]!.cadence, state.lastRun[name])) {
        logger.info(`startup: running ${name} now (${opts.kickoff ? "kickoff" : "catch-up"})`);
        void runProposerSafe(name, true);
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
