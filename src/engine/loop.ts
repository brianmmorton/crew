import type { CrewConfig, Logger } from "../types.js";
import type { Ports } from "./ports.js";
import { implementerCycle } from "./cycles.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Interruptible sleep: wakeExecutor() resolves the current one early, so a
// hotkey ("run implementer now") can skip the idle poll wait.
let wake: (() => void) | null = null;
function sleepInterruptible(ms: number): Promise<void> {
  return new Promise<void>((res) => {
    const t = setTimeout(() => {
      wake = null;
      res();
    }, ms);
    wake = () => {
      clearTimeout(t);
      wake = null;
      res();
    };
  });
}
export function wakeExecutor(): void {
  wake?.();
}

let paused = false;
export function setPaused(p: boolean): void {
  paused = p;
}

let stopped = false;
export function requestStop(): void {
  stopped = true;
  wake?.();
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
  logger.info("crew executor loop started", {
    project: cfg.project,
    wipCap: cfg.gates.wipCap,
  });

  // When the current dry spell started, or null if the executor isn't idle.
  // Paused and WIP-capped are deliberately *not* idle: there is work, it just
  // isn't runnable right now, and proposing more wouldn't help.
  let idleSince: number | null = null;

  while (!stopped) {
    try {
      if (paused) {
        idleSince = null;
        await sleepInterruptible(cfg.budget.pollSeconds * 1000);
        continue;
      }

      const inProgress = await ports.tracker.countInProgress();
      if (inProgress >= cfg.gates.wipCap) {
        idleSince = null;
        await sleepInterruptible(cfg.budget.pollSeconds * 1000);
        continue;
      }

      const outcome = await implementerCycle(cfg, ports, logger);

      if (outcome.status === "usage-limited") {
        const ms = backoffMs(outcome.resetAt, cfg.budget.backoffMinutes);
        logger.warn(`usage limited; backing off ${Math.round(ms / 60000)}m`, {
          resetAt: outcome.resetAt ?? null,
        });
        // Not idle — we're rate-limited, and there may well be work waiting.
        // Leaving idleSince set would make the long sleep look like a dry spell
        // and fire every idle proposer the moment the window reopens.
        idleSince = null;
        await sleep(ms); // not interruptible: waking would just re-hit the limit
      } else if (outcome.status === "idle") {
        const now = Date.now();
        if (idleSince === null) idleSince = now;

        let backlog = 0;
        try {
          backlog = await ports.tracker.countBacklog();
        } catch {
          /* ignore — treated as an empty backlog for logging and idle triggers */
        }

        // Explain the idle, throttled to ~5 min, so it's never a silent mystery.
        if (now - lastIdleLog > 5 * 60 * 1000) {
          lastIdleLog = now;
          logger.info(
            `executor idle: no ready work in "${cfg.tracker.statuses.ready}" ` +
              `(labeled type:task/bug/chore-dx). ${backlog} in "${cfg.tracker.statuses.backlog}". ` +
              `Move an item to "${cfg.tracker.statuses.ready}" + add a type label, then press i.`,
          );
        }

        onIdle?.(now - idleSince, backlog);
        await sleepInterruptible(cfg.budget.pollSeconds * 1000);
      } else {
        // Real work happened, so the next dry spell is a fresh one.
        idleSince = null;
        await sleep(2000); // did work; brief pause before the next claim
      }
    } catch (e) {
      logger.error("executor loop tick failed; continuing", { error: String(e) });
      await sleepInterruptible(cfg.budget.pollSeconds * 1000);
    }
  }
  logger.info("crew executor loop stopped");
}
