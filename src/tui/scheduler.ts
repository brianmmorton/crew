import { Cron } from "croner";
import type { CrewConfig, PersonaName } from "../types.js";
import type { Ports } from "../engine/ports.js";
import { scheduledAgents } from "../agent/agents.js";
import { decideIdleRun, dueOnStartup, shouldRunProposer } from "../engine/schedule.js";
import { setIdleHandler, wakeExecutor } from "../engine/loop.js";
import { readState, writeState } from "../util/state.js";
import { logger } from "../util/logger.js";
import { poolStore } from "./stores/pool.js";
import { runsStore } from "./stores/runs.js";
import { isRunning, startRun } from "./runManager.js";

/**
 * Proposer scheduling for the TUI: cron cadences, the startup catch-up pass,
 * and idle-triggered early runs. This is what used to live inside
 * `runSupervised` — the TUI is now the only way to run the team, so the
 * scheduling has to live where the TUI can see it.
 *
 * Every run — cron, catch-up, idle, or hotkey — goes through runManager's
 * `crew once <agent>` child process. That's the single choke point, so a
 * scheduled run shows up in the agent's output pane exactly like a manual one,
 * and one agent can never be running twice.
 */

let jobs: Cron[] = [];
/** Consecutive idle-triggered runs that filed nothing. */
let emptyIdleRuns = 0;
let idleRunning = false;
/**
 * Backlog depth when we last gave up. If it changes, something happened on the
 * board (you filed, promoted, or closed something) and the agents have new
 * ground to cover — so the give-up latch clears rather than needing a restart.
 */
let gaveUpAtBacklog: number | null = null;

/**
 * Fire a proposer unless it ran too recently. `manual` bypasses the throttle —
 * you asked for it explicitly.
 *
 * Returns whether a run actually started. Note this resolves when the child is
 * SPAWNED, not when it finishes; the idle path watches for completion
 * separately, since only a finished run can be judged empty or productive.
 */
function runProposer(cfg: CrewConfig, name: PersonaName, manual = false): boolean {
  const since = sinceLastRun(cfg, name);
  const decision = shouldRunProposer({
    running: isRunning(name),
    paused: poolStore.executorPaused,
    manual,
    sinceLastRun: since,
    minIntervalMinutes: cfg.idle.minIntervalMinutes,
  });
  if (!decision.run) {
    if (decision.reason === "running") {
      logger.info(`${name}: previous run still going; skipping`);
    } else if (decision.reason === "throttled") {
      logger.info(
        `${name}: ran ${Math.round(since / 60_000)}m ago ` +
          `(minIntervalMinutes=${cfg.idle.minIntervalMinutes}); skipping`,
      );
    }
    return false;
  }
  startRun(name);
  markRan(cfg, name);
  return true;
}

/** Ms since a proposer last completed; Infinity if it never has. */
function sinceLastRun(cfg: CrewConfig, name: PersonaName): number {
  const t = Date.parse(readState(cfg.configDir).lastRun[name] ?? "");
  return Number.isNaN(t) ? Infinity : Date.now() - t;
}

/**
 * Stamp the run time at START, not completion. The throttle exists to stop a
 * cadence from stacking runs; stamping on completion would let a long run be
 * re-fired by the next tick before it ever recorded itself.
 */
function markRan(cfg: CrewConfig, name: PersonaName): void {
  const state = readState(cfg.configDir);
  state.lastRun[name] = new Date().toISOString();
  writeState(cfg.configDir, state);
}

export function startScheduler(cfg: CrewConfig, ports: Ports): void {
  stopScheduler();

  // Every agent with a cron cadence — built-in or user-defined. Reviewers are
  // driven by the executor cycle, not scheduled, so they're excluded here.
  const scheduled = scheduledAgents(Object.values(ports.agents))
    .filter((a) => a.kind === "proposer")
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const a of scheduled) {
    let job: Cron;
    try {
      job = new Cron(a.cadence, { name: a.name, protect: true }, () => {
        runProposer(cfg, a.name);
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
  if (!jobs.length) logger.warn("no proposers scheduled (none enabled with a cadence)");

  startIdleTriggers(cfg, scheduled.map((a) => a.name));

  // Catch-up: anything that missed a tick while the TUI was down runs now,
  // so a restart produces activity instead of a wait for the next cadence.
  const state = readState(cfg.configDir);
  for (const a of scheduled) {
    if (dueOnStartup(a.cadence, state.lastRun[a.name])) {
      logger.info(`startup: running ${a.name} now (catch-up)`);
      runProposer(cfg, a.name, true);
    }
  }
}

/**
 * When the executor runs dry, pull a proposer in early rather than waiting for
 * its next cron tick. One agent at a time, oldest-run first: as soon as one
 * files something the executor stops being idle, so firing the whole roster
 * would just dump every agent's proposals into an empty backlog at once.
 */
function startIdleTriggers(cfg: CrewConfig, names: PersonaName[]): void {
  const pool = cfg.idle.agents.length
    ? names.filter((n) => cfg.idle.agents.includes(n))
    : names;

  if (!cfg.idle.enabled) return;
  if (!pool.length) {
    logger.info("idle triggers enabled but no proposers to run");
    return;
  }
  const unknown = cfg.idle.agents.filter((n) => !names.includes(n));
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
        paused: poolStore.executorPaused,
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
    const next = [...pool]
      .filter((n) => !isRunning(n))
      .sort((a, b) => {
        const [sa, sb] = [sinceLastRun(cfg, a), sinceLastRun(cfg, b)];
        if (sa !== sb) return sb - sa;
        return a.localeCompare(b);
      })[0];
    if (!next) return;
    if (sinceLastRun(cfg, next) < cfg.idle.minIntervalMinutes * 60_000) return;

    logger.info(
      `idle ${Math.round(idleMs / 60_000)}m with an empty queue; running ${next} early`,
    );
    if (!runProposer(cfg, next)) return;
    idleRunning = true;
    void awaitRun(next).then((filed) => {
      idleRunning = false;
      if (filed) {
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
    });
  });
}

/**
 * Resolve once an agent's child run leaves the running state, reporting
 * whether it looks productive.
 *
 * The child is a separate process, so its filed-item count isn't a return
 * value here — a clean exit is the proxy for "did something". That's coarser
 * than the in-process count the old supervisor had, and it errs toward
 * treating a run as productive, which only ever delays the give-up latch.
 */
function awaitRun(agent: PersonaName): Promise<boolean> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (isRunning(agent)) return;
      clearInterval(poll);
      resolve(runsStore.byAgent[agent]?.status === "done");
    }, 1000);
    poll.unref?.();
  });
}

export function stopScheduler(): void {
  for (const j of jobs) j.stop();
  jobs = [];
  setIdleHandler(null); // module-level: don't leak this run's closure into the next
  emptyIdleRuns = 0;
  idleRunning = false;
  gaveUpAtBacklog = null;
}

/** Pause/resume the cron jobs alongside the worker pool. */
export function setSchedulerPaused(paused: boolean): void {
  for (const j of jobs) (paused ? j.pause() : j.resume());
}
