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

  while (!stopped) {
    try {
      if (paused) {
        await sleepInterruptible(cfg.budget.pollSeconds * 1000);
        continue;
      }

      const inProgress = await ports.linear.countInProgress();
      if (inProgress >= cfg.gates.wipCap) {
        await sleepInterruptible(cfg.budget.pollSeconds * 1000);
        continue;
      }

      const outcome = await implementerCycle(cfg, ports, logger);

      if (outcome.status === "usage-limited") {
        const ms = backoffMs(outcome.resetAt, cfg.budget.backoffMinutes);
        logger.warn(`usage limited; backing off ${Math.round(ms / 60000)}m`, {
          resetAt: outcome.resetAt ?? null,
        });
        await sleep(ms); // not interruptible: waking would just re-hit the limit
      } else if (outcome.status === "idle") {
        // Explain the idle, throttled to ~5 min, so it's never a silent mystery.
        const now = Date.now();
        if (now - lastIdleLog > 5 * 60 * 1000) {
          lastIdleLog = now;
          let backlog = 0;
          try {
            backlog = await ports.linear.countBacklog();
          } catch {
            /* ignore */
          }
          logger.info(
            `executor idle: no ready work in "${cfg.linear.statuses.ready}" ` +
              `(labeled type:task/bug/chore-dx). ${backlog} in "${cfg.linear.statuses.backlog}". ` +
              `Move an item to "${cfg.linear.statuses.ready}" + add a type label, then press i.`,
          );
        }
        await sleepInterruptible(cfg.budget.pollSeconds * 1000);
      } else {
        await sleep(2000); // did work; brief pause before the next claim
      }
    } catch (e) {
      logger.error("executor loop tick failed; continuing", { error: String(e) });
      await sleepInterruptible(cfg.budget.pollSeconds * 1000);
    }
  }
  logger.info("crew executor loop stopped");
}
