import { Cron } from "croner";

/**
 * Pure scheduling decisions for proposer agents: when a cadence is due, and
 * whether an idle executor should pull a proposer in early.
 *
 * Deliberately free of engine, config, and I/O imports — these are the rules,
 * and they're tested directly. The caller (tui/scheduler.ts) owns the clocks,
 * the child processes, and the persisted state.
 */

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
 * restarts.
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

/**
 * Should a proposer actually fire? The single rule every trigger — cron,
 * catch-up, idle, hotkey — is checked against, so one throttle governs them
 * all rather than each keeping its own clock and doubling up.
 *
 * `manual` (a hotkey) bypasses the throttle and the pause: you asked for it
 * explicitly. It never bypasses `running`, because two concurrent runs of one
 * agent would race for the same claims.
 */
export function shouldRunProposer(input: {
  running: boolean;
  paused: boolean;
  manual: boolean;
  /** Ms since this proposer last started; Infinity if it never has. */
  sinceLastRun: number;
  minIntervalMinutes: number;
}): { run: false; reason: "running" | "paused" | "throttled" } | { run: true } {
  if (input.running) return { run: false, reason: "running" };
  if (input.manual) return { run: true };
  if (input.paused) return { run: false, reason: "paused" };
  if (input.sinceLastRun < input.minIntervalMinutes * 60_000) {
    return { run: false, reason: "throttled" };
  }
  return { run: true };
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
