import { Cron } from "croner";
import readline from "node:readline";
import type { CrewConfig, Logger, PersonaName } from "../types.js";
import type { Ports } from "./ports.js";
import { proposerCycle } from "./cycles.js";
import {
  runExecutorLoop,
  requestStop,
  wakeExecutor,
  setPaused,
  setIdleHandler,
} from "./loop.js";
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

/** Inputs to the idle-trigger decision. Pure, so the rules are testable. */
export interface IdleDecisionInput {
  /** How long the executor has been continuously idle. */
  idleMs: number;
  /** Items sitting in the backlog state. */
  backlog: number;
  /** Consecutive idle runs that filed nothing. */
  emptyRuns: number;
  /** Backlog depth when we last gave up, if we have. */
  gaveUpAtBacklog: number | null;
  paused: boolean;
  /** Already running an idle-triggered proposer. */
  running: boolean;
}

export type IdleDecision =
  | { run: false; reason: string }
  | { run: true; clearedLatch: boolean };

/**
 * Decide whether an idle tick should pull a proposer in early.
 *
 * The give-up latch (`emptyRuns >= maxEmptyRuns`) is what stops a runaway loop:
 * if idle runs keep filing nothing, we stop paying for them. It clears when the
 * backlog depth differs from where we gave up, since that means the board moved
 * and there's genuinely new ground to cover.
 */
export function decideIdleRun(
  input: IdleDecisionInput,
  cfg: { afterMinutes: number; maxBacklog: number; maxEmptyRuns: number },
): IdleDecision {
  if (input.paused) return { run: false, reason: "paused" };
  if (input.running) return { run: false, reason: "already running" };
  if (input.idleMs < cfg.afterMinutes * 60_000) {
    return { run: false, reason: "not idle long enough" };
  }
  if (input.backlog > cfg.maxBacklog) {
    return { run: false, reason: "backlog needs promoting, not deepening" };
  }
  if (input.emptyRuns >= cfg.maxEmptyRuns) {
    if (input.gaveUpAtBacklog !== null && input.backlog === input.gaveUpAtBacklog) {
      return { run: false, reason: "gave up; board unchanged" };
    }
    return { run: true, clearedLatch: true };
  }
  return { run: true, clearedLatch: false };
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

  /** Ms since a proposer last completed; Infinity if it never has. */
  const sinceLastRun = (name: PersonaName): number => {
    const t = Date.parse(state.lastRun[name] ?? "");
    return Number.isNaN(t) ? Infinity : Date.now() - t;
  };

  /**
   * Run a proposer, unless it ran too recently. `manual` (a hotkey) bypasses the
   * throttle — you asked for it explicitly. Returns how many items it filed, so
   * the idle trigger can tell a productive run from an empty one.
   *
   * This is the single choke point for every proposer run — cron, catch-up,
   * hotkey, and idle all land here, so one throttle governs them all rather than
   * cron and idle each keeping their own clock and doubling up.
   */
  const runProposerSafe = async (
    name: PersonaName,
    manual = false,
  ): Promise<number> => {
    if (teamPaused && !manual) return 0;
    if (!ports.agents[name]) {
      logger.warn(`${name}: not enabled (no personas/${name}.md); ignoring`);
      return 0;
    }
    if (busy.has(name)) {
      logger.info(`${name}: previous run still going; skipping`);
      return 0;
    }
    if (!manual && sinceLastRun(name) < cfg.idle.minIntervalMinutes * 60_000) {
      logger.info(
        `${name}: ran ${Math.round(sinceLastRun(name) / 60_000)}m ago ` +
          `(minIntervalMinutes=${cfg.idle.minIntervalMinutes}); skipping`,
      );
      return 0;
    }
    busy.add(name);
    try {
      const out = await proposerCycle(cfg, ports, name, logger);
      const filed = out.created?.length ?? 0;
      logger.info(`${name} finished`, { status: out.status, filed });
      state.lastRun[name] = new Date().toISOString();
      writeState(cfg.configDir, state);
      return filed;
    } catch (e) {
      logger.error(`${name} run failed`, { error: String(e) });
      return 0;
    } finally {
      busy.delete(name);
    }
  };

  // --- schedule proposers -----------------------------------------------------
  if (opts.proposers) {
    for (const a of scheduled) {
      let job: Cron;
      try {
        job = new Cron(a.cadence, { name: a.name, protect: true }, () => {
          void runProposerSafe(a.name);
        });
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

  // --- idle-triggered proposers -----------------------------------------------
  // When the executor runs dry, pull a proposer in early rather than waiting for
  // its next cron tick. One agent at a time, oldest-run first: as soon as one
  // files something the executor stops being idle, so firing the whole roster
  // would just dump every agent's proposals into an empty backlog at once.
  const idlePool = cfg.idle.agents.length
    ? scheduled.filter((a) => cfg.idle.agents.includes(a.name))
    : scheduled;
  /** Consecutive idle-triggered runs that filed nothing. */
  let emptyIdleRuns = 0;
  let idleRunning = false;
  /**
   * Backlog depth when we last gave up. If it changes, something happened on the
   * board (you filed, promoted, or closed something) and the agents have new
   * ground to cover — so the give-up latch clears rather than needing a restart.
   */
  let gaveUpAtBacklog: number | null = null;

  if (cfg.idle.enabled && opts.proposers && idlePool.length) {
    const unknown = cfg.idle.agents.filter((n) => !scheduled.some((a) => a.name === n));
    if (unknown.length) {
      logger.warn(`idle.agents names no scheduled proposer: ${unknown.join(", ")}`);
    }

    setIdleHandler((idleMs, backlog) => {
      const decision = decideIdleRun(
        {
          idleMs,
          backlog,
          emptyRuns: emptyIdleRuns,
          gaveUpAtBacklog,
          paused: teamPaused,
          running: idleRunning,
        },
        cfg.idle,
      );
      if (!decision.run) return;
      if (decision.clearedLatch) {
        logger.info("board changed since idle proposers gave up; trying again");
        emptyIdleRuns = 0;
        gaveUpAtBacklog = null;
      }

      // Oldest first, so the roster rotates instead of one agent monopolizing.
      // Never-run agents are all Infinity, and Infinity - Infinity is NaN, so
      // compare before subtracting — otherwise a fleet of fresh agents sorts
      // arbitrarily instead of falling back to name order.
      const next = [...idlePool]
        .filter((a) => !busy.has(a.name))
        .sort((a, b) => {
          const [sa, sb] = [sinceLastRun(a.name), sinceLastRun(b.name)];
          if (sa !== sb) return sb - sa;
          return a.name.localeCompare(b.name);
        })[0];
      if (!next) return;
      if (sinceLastRun(next.name) < cfg.idle.minIntervalMinutes * 60_000) return;

      idleRunning = true;
      logger.info(
        `idle ${Math.round(idleMs / 60_000)}m with an empty queue; running ${next.name} early`,
      );
      void runProposerSafe(next.name)
        .then((filed) => {
          if (filed > 0) {
            emptyIdleRuns = 0;
            wakeExecutor(); // new work is ready — don't wait out the poll interval
            return;
          }
          emptyIdleRuns++;
          if (emptyIdleRuns >= cfg.idle.maxEmptyRuns) {
            gaveUpAtBacklog = backlog;
            logger.warn(
              `idle proposers filed nothing ${emptyIdleRuns} runs in a row; pausing idle ` +
                `triggers until the board changes. They still run on their normal cadence.`,
            );
          }
        })
        .finally(() => {
          idleRunning = false;
        });
    });
  } else if (cfg.idle.enabled && opts.proposers) {
    logger.info("idle triggers enabled but no proposers to run");
  }

  // --- shutdown ---------------------------------------------------------------
  let down = false;
  const shutdown = (sig: string): void => {
    if (down) return;
    down = true;
    logger.info(`${sig}; stopping after current work`);
    setIdleHandler(null);
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
      ports.tracker.countBacklog(),
      ports.tracker.countInProgress(),
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
  setIdleHandler(null); // module-level: don't leak this run's closure into the next
  for (const j of jobs) j.stop();
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  }
}
