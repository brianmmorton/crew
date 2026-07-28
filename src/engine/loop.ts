import type { CrewConfig, EmptySelectionReason, Logger } from "../types.js";
import type { Ports } from "./ports.js";
import { implementerCycle, type CycleOutcome } from "./cycles.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How many consecutive lost claim races before the loop backs off to its normal
 * poll interval. Retrying immediately is right when a sibling worker just beat
 * us to one item; spinning is wrong when every item on the board is taken.
 */
const MAX_CONTENDED_RUN = 5;

// Interruptible sleep: wakeExecutor() resolves the current one early, so a
// hotkey ("run implementer now") can skip the idle poll wait.
//
// A Set rather than a single slot: with implementerWorkers > 1 several workers
// sleep concurrently, and a single slot would leave all but the last one
// waiting out the full interval after a hotkey.
const waiters = new Set<() => void>();
function sleepInterruptible(ms: number): Promise<void> {
  return new Promise<void>((res) => {
    const done = () => {
      clearTimeout(t);
      waiters.delete(done);
      res();
    };
    const t = setTimeout(done, ms);
    waiters.add(done);
  });
}
export function wakeExecutor(): void {
  for (const w of [...waiters]) w();
}

let paused = false;
export function setPaused(p: boolean): void {
  paused = p;
}

let stopped = false;
export function requestStop(): void {
  stopped = true;
  wakeExecutor();
}

/**
 * Clear a previous run's stop, so `runExecutorLoop` can be called again in the
 * same process (the CLI does; tests certainly do).
 *
 * Deliberately NOT done inside `runExecutorLoop`: the supervisor installs its
 * signal handlers before calling it, and a SIGINT arriving in that window must
 * still stop the loop rather than be erased. Callers that genuinely want a
 * fresh start say so.
 */
export function resetStop(): void {
  stopped = false;
}

let lastIdleLog = 0;

/**
 * Notified on every idle tick with how long the executor has been continuously
 * idle. The supervisor uses this to pull proposers in early; nothing else
 * depends on it, so a missing handler just means the old behaviour.
 */
let onIdle: ((idleMs: number, backlog: number) => void) | null = null;
export function setIdleHandler(h: ((idleMs: number, backlog: number) => void) | null): void {
  onIdle = h;
}

/**
 * Say what a finished cycle actually did. Every non-idle status gets a line at
 * the severity it deserves, so scanning the log for "what happened to that
 * ticket" never comes up empty — and a failed cycle never reads as a success.
 */
function logCycleOutcome(outcome: CycleOutcome, logger: Logger, tag = ""): void {
  const detail = outcome.detail ? ` — ${outcome.detail}` : "";
  switch (outcome.status) {
    case "pr-opened":
      logger.info(`${tag}cycle finished: PR opened${outcome.url ? ` → ${outcome.url}` : ""}`);
      return;
    case "no-commit":
      logger.warn(
        `${tag}cycle finished: the agent made no commit; the item was returned to the backlog${detail}`,
      );
      return;
    case "rejected":
      logger.warn(`${tag}cycle finished: rejected by the no-touch gate${detail}`);
      return;
    case "verify-failed":
      // Not necessarily a demote any more: the first failure keeps the commit
      // and hands it back to the agent to fix.
      logger.warn(`${tag}cycle finished: the verify gate failed${detail}`);
      return;
    case "error":
      logger.error(`${tag}cycle finished: error${detail}`);
      return;
    default:
      logger.info(`${tag}cycle finished: ${outcome.status}${detail}`);
  }
}

/** Compute back-off ms from a parsed reset time, else the configured default. */
export function backoffMs(resetAt: string | null | undefined, defaultMinutes: number): number {
  if (resetAt) {
    const t = Date.parse(resetAt);
    if (!Number.isNaN(t)) {
      const delta = t - Date.now() + 60_000; // 1 min past the reset
      if (delta > 0) return delta;
    }
  }
  return defaultMinutes * 60_000;
}

/**
 * The always-on executor: continuously drains ready work into PRs, respecting
 * the WIP cap, and backs off precisely when the Claude usage window is spent.
 * Can be paused (setPaused) and nudged awake (wakeExecutor) by the supervisor.
 */
export async function runExecutorLoop(
  cfg: CrewConfig,
  ports: Ports,
  logger: Logger,
): Promise<void> {
  const workers = Math.max(1, cfg.budget.implementerWorkers ?? 1);
  logger.info("crew executor loop started", {
    project: cfg.project,
    wipCap: cfg.gates.wipCap,
    workers,
  });
  if (workers > 1 && !cfg.worktrees.reuse) {
    // Without pooling each cycle creates its own worktree, so N workers means N
    // concurrent full checkouts of the repo. That is legal but rarely intended.
    logger.warn(
      `implementerWorkers=${workers} with worktrees.reuse off: every worker creates its own ` +
        `checkout. Set worktrees.reuse: true to share a bounded pool instead.`,
    );
  }

  // Module-level, so reset per run rather than inheriting a previous loop's
  // counts (the CLI runs this more than once in a process, and tests certainly do).
  // `stopped` is deliberately NOT reset: the supervisor installs its signal
  // handlers before calling this, and a SIGINT in that window must still stop
  // the loop rather than be erased here.
  idleSince = null;
  idleWorkers = 0;

  // Workers are symmetric and coordinate through the per-item claim, so the
  // only shared state is the idle bookkeeping below — which must stay single,
  // or N workers would each report a dry spell and fire N idle proposers.
  await Promise.all(
    Array.from({ length: workers }, (_, i) => runWorker(cfg, ports, logger, i, workers)),
  );
  logger.info("crew executor loop stopped");
}

/** When the executor as a whole went dry, or null while any worker has work. */
let idleSince: number | null = null;
/** Workers currently reporting idle; a dry spell needs all of them. */
let idleWorkers = 0;

/** One executor worker. Several run concurrently when implementerWorkers > 1. */
async function runWorker(
  cfg: CrewConfig,
  ports: Ports,
  logger: Logger,
  index: number,
  total: number,
): Promise<void> {
  /** Prefix so interleaved output is attributable when several workers run. */
  const tag = total > 1 ? `w${index}: ` : "";
  /** Consecutive ticks that lost the claim race; reset by any real outcome. */
  let contended = 0;
  /** Whether THIS worker is currently counted in `idleWorkers`. */
  let countedIdle = false;
  const notIdle = () => {
    if (countedIdle) {
      countedIdle = false;
      idleWorkers--;
    }
    idleSince = null;
  };

  while (!stopped) {
    try {
      if (paused) {
        notIdle();
        await sleepInterruptible(cfg.budget.pollSeconds * 1000);
        continue;
      }

      const inProgress = await ports.tracker.countInProgress();
      if (inProgress >= cfg.gates.wipCap) {
        notIdle();
        await sleepInterruptible(cfg.budget.pollSeconds * 1000);
        continue;
      }

      const outcome = await implementerCycle(cfg, ports, logger);

      if (outcome.status === "contended") {
        // Another worker took this item. There is work on the board, so don't
        // sleep out a poll interval — come straight back for the next one. The
        // short pause keeps a pathological case (every item claimed, all of
        // them losing) from becoming a hot loop against the tracker.
        notIdle();
        contended++;
        if (contended >= MAX_CONTENDED_RUN) {
          logger.info(
            `every item offered was already claimed (${contended} in a row); waiting a tick`,
          );
          contended = 0;
          await sleepInterruptible(cfg.budget.pollSeconds * 1000);
        } else {
          await sleep(250);
        }
        continue;
      }
      contended = 0;

      if (outcome.status === "usage-limited") {
        const ms = backoffMs(outcome.resetAt, cfg.budget.backoffMinutes);
        logger.warn(`usage limited; backing off ${Math.round(ms / 60000)}m`, {
          resetAt: outcome.resetAt ?? null,
        });
        // Not idle — we're rate-limited, and there may well be work waiting.
        // Leaving idleSince set would make the long sleep look like a dry spell
        // and fire every idle proposer the moment the window reopens.
        notIdle();
        await sleep(ms); // not interruptible: waking would just re-hit the limit
      } else if (outcome.status === "idle") {
        const now = Date.now();
        if (!countedIdle) {
          countedIdle = true;
          idleWorkers++;
        }
        // The dry spell starts only when EVERY worker has run out of work —
        // otherwise one worker finishing early would report the team as idle
        // while its siblings are still implementing.
        const allIdle = idleWorkers >= total;
        if (allIdle && idleSince === null) idleSince = now;

        let backlog = 0;
        try {
          backlog = await ports.tracker.countBacklog();
        } catch {
          /* ignore — treated as an empty backlog for logging and idle triggers */
        }

        // Explain the idle, throttled to ~5 min, so it's never a silent mystery.
        // Only once the whole team is dry, and `lastIdleLog` is module-level so
        // N workers share one throttle rather than each logging its own.
        if (allIdle && now - lastIdleLog > 5 * 60 * 1000) {
          lastIdleLog = now;

          // A label gate that rejects everything looks identical to an empty
          // queue from here, so ask the tracker to attribute it before falling
          // back to the generic message. Diagnostic only — never fatal.
          let gated: EmptySelectionReason | null = null;
          try {
            gated = (await ports.tracker.explainEmptySelection?.()) ?? null;
          } catch {
            /* ignore — a failed diagnostic must not disturb the idle path */
          }

          if (gated && gated.ready > 0 && gated.passedGate === 0) {
            const clauses = [
              gated.requireLabels.length ? `requireLabels: ${gated.requireLabels.join(", ")}` : "",
              gated.excludeLabels.length ? `excludeLabels: ${gated.excludeLabels.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("; ");
            logger.warn(
              `executor idle: ${gated.ready} item(s) in "${cfg.tracker.statuses.ready}" but 0 passed ` +
                `the label gate (${clauses}). Check tracker.executable in ${cfg.configDir}/config.yaml — ` +
                `a label that matches nothing on the board stalls the executor.`,
            );
          } else {
            logger.info(
              `executor idle: no ready work in "${cfg.tracker.statuses.ready}" ` +
                `(labeled type:task/bug/chore-dx). ${backlog} in "${cfg.tracker.statuses.backlog}". ` +
                `Move an item to "${cfg.tracker.statuses.ready}" + add a type label, then press i.`,
            );
          }
        }

        if (allIdle && idleSince !== null) onIdle?.(now - idleSince, backlog);
        await sleepInterruptible(cfg.budget.pollSeconds * 1000);
      } else {
        // Real work happened, so the next dry spell is a fresh one. "Work
        // happened" is not the same as "work succeeded" — a rejected or
        // verify-failed cycle lands here too, so state the outcome plainly
        // rather than letting a failure look like a quiet success.
        notIdle();
        logCycleOutcome(outcome, logger, tag);
        await sleep(2000); // did work; brief pause before the next claim
      }
    } catch (e) {
      logger.error("executor loop tick failed; continuing", { error: String(e) });
      await sleepInterruptible(cfg.budget.pollSeconds * 1000);
    }
  }
  // Per-worker; `runExecutorLoop` logs the single "loop stopped" once every
  // worker has drained, so this one stays tagged to avoid reading as a
  // duplicate of it in the single-worker case.
  if (tag) logger.info(`${tag}worker stopped`);
}
