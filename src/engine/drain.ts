import { exec } from "node:child_process";
import type { AgentDef, CrewConfig, Logger, WorkItem } from "../types.js";
import type { Ports } from "./ports.js";
import { proposerCycle } from "./cycles.js";
import { backoffMs } from "./loop.js";

/**
 * Drain sessions: run one proposer to completion instead of once per cron tick.
 *
 * A drain agent (mode: "drain") is started manually — `crew drain <name>` or
 * the TUI run key — and loops: check the goal, wait while the executor has
 * enough in flight, propose, repeat. The session ends when `doneWhen` exits 0
 * (the goal is met in the repo), when iterations stop filing anything, or at
 * the iteration cap. Built for finite work with a checkable end state, e.g.
 * "migrate every jest test to vitest": `doneWhen` greps for what remains, and
 * the session outlives any single agent run.
 *
 * The whole session runs in ONE process (the `crew drain` child), so each
 * iteration's outcome — including what it filed — is an in-process value, not
 * something inferred from an exit code.
 */

/** Iteration backstop when the config doesn't set one. Each costs an agent run. */
export const DEFAULT_MAX_ITERATIONS = 12;

/**
 * Proposals per iteration when the persona doesn't set `maxProposals`. One on
 * purpose: a drain session's pace should be set by work landing, and each
 * proposal becomes a PR someone has to review — a migration that files a
 * ten-item wall per iteration overwhelms reviewers, which is exactly the
 * failure mode maxInProgress exists to prevent on the execution side.
 */
export const DEFAULT_DRAIN_MAX_PROPOSALS = 1;

/**
 * Consecutive iterations that file nothing before the session stops. With a
 * `doneWhen` the check is the authority on "done", so an empty iteration means
 * "everything left is already covered by open or in-flight issues" — worth one
 * retry after the board moves. Without one, an empty iteration IS the
 * completion signal, so one is enough.
 */
export function maxUnproductive(hasDoneWhen: boolean): number {
  return hasDoneWhen ? 2 : 1;
}

// ------------------------- pure decision logic ------------------------------

/** One tick's inputs. Pure, so the rules are testable (see schedule.ts). */
export interface DrainTickInput {
  /** doneWhen verdict this tick; null when no check is configured. */
  done: boolean | null;
  /** Tracker items currently in the in-progress state. */
  inProgress: number;
  /** Agent iterations already run this session. */
  iterations: number;
  /** Consecutive iterations that filed nothing. */
  unproductive: number;
}

export interface DrainLimits {
  maxInProgress: number;
  maxIterations: number;
  maxUnproductive: number;
}

export type DrainStep =
  | { step: "complete" }
  | { step: "stop"; reason: "no-progress" | "iteration-cap" }
  | { step: "wait" }
  | { step: "propose" };

/**
 * Decide what a drain tick does. Order matters: completion always wins (even
 * over the caps — the goal being met is never a failure), then the stops, then
 * the concurrency wait. `wait` is not an iteration and cannot stop the session;
 * only agent runs count against the caps, because they're what costs money.
 */
export function decideDrainStep(input: DrainTickInput, limits: DrainLimits): DrainStep {
  if (input.done === true) return { step: "complete" };
  if (input.unproductive >= limits.maxUnproductive) {
    return { step: "stop", reason: "no-progress" };
  }
  if (input.iterations >= limits.maxIterations) {
    return { step: "stop", reason: "iteration-cap" };
  }
  if (input.inProgress >= limits.maxInProgress) return { step: "wait" };
  return { step: "propose" };
}

// ------------------------------ the session ---------------------------------

export interface DrainOutcome {
  status: "complete" | "stopped" | "error";
  /** Why a non-complete session ended. */
  reason?: string;
  /** Agent iterations that actually ran. */
  iterations: number;
  /** Every identifier filed across the session. */
  filed: string[];
  /** Last `doneWhen` output — what remains, for the final report. */
  remaining?: string;
}

/**
 * Run the completion check from the repo root. Exit 0 = the goal is met. The
 * output (stdout, else stderr) is kept: it's both the "what remains" context
 * fed to the agent and the evidence in the final report. A check that can't
 * run at all reads as "not done" — the iteration cap bounds the damage, and
 * the output carries the error for the log.
 */
export function runDoneWhen(
  cmd: string,
  cwd: string,
): Promise<{ done: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = (stdout.trim() || stderr.trim()).slice(0, 4_000);
      resolve({ done: !err, output });
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Throttle for the "waiting on in-progress work" log line. */
const WAIT_LOG_MS = 5 * 60_000;

/**
 * Extra prompt context for one drain iteration. The completion check's output
 * is the most valuable part: it tells the agent exactly what remains, so the
 * persona prompt can stay a description of the goal rather than a search
 * procedure. The open-issue list is what lets it propose around in-flight
 * work; the filed list covers this session's items the dedup pass hasn't
 * caught yet.
 */
export function drainContext(
  def: AgentDef,
  remaining: string | undefined,
  filed: string[],
  openItems: WorkItem[],
  maxProposals: number,
): string {
  const openLines = openItems
    .slice(0, 50)
    .map((i) => `- ${i.identifier} [${i.stateName}] ${i.title}`)
    .join("\n");
  return [
    `# Drain session`,
    `You are one iteration of a run-to-completion session working toward a single goal.`,
    `You DO NOT do the work — you file it. Describe the next unit of work as a task for`,
    `the implementer; never edit, commit, or run write operations yourself.`,
    ``,
    `File at most ${maxProposals} item(s) this iteration, each sized to become ONE`,
    `reviewable pull request. Scope it to files no open issue already covers, and say`,
    `exactly which files it covers, so concurrent work never overlaps. When nothing new`,
    `is left to file, file nothing — that is a good outcome, not a failure.`,
    openLines
      ? `\nOpen issues on the board — do NOT propose work these already cover:\n${openLines}`
      : "",
    remaining
      ? `\nCurrent output of the completion check (\`${def.doneWhen}\`) — this is what remains:\n\n\`\`\`\n${remaining}\n\`\`\``
      : "",
    filed.length
      ? `\nAlready filed this session (do NOT re-propose): ${filed.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Run one drain agent to completion. Blocks until the session ends. */
export async function runDrainSession(
  cfg: CrewConfig,
  ports: Ports,
  def: AgentDef,
  logger: Logger,
): Promise<DrainOutcome> {
  const limits: DrainLimits = {
    maxInProgress: def.maxInProgress ?? cfg.gates.wipCap,
    maxIterations: def.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    maxUnproductive: maxUnproductive(!!def.doneWhen),
  };
  logger.info(`${def.name}: drain session started`, {
    doneWhen: def.doneWhen ?? null,
    maxInProgress: limits.maxInProgress,
    maxIterations: limits.maxIterations,
  });

  let iterations = 0;
  let unproductive = 0;
  let waiting = false;
  let lastWaitLog = 0;
  const filed: string[] = [];

  for (;;) {
    // Fresh view of the base branch, so a check like `git grep ... origin/main`
    // sees merged work. Never fatal: offline just means a staler verdict.
    await ports.git.syncBase().catch((e) => {
      logger.warn(`${def.name}: could not sync the base branch before the check`, {
        error: String(e),
      });
    });
    const check = def.doneWhen ? await runDoneWhen(def.doneWhen, cfg.repo.path) : null;
    const inProgress = await ports.tracker.countInProgress();

    const step = decideDrainStep(
      { done: check?.done ?? null, inProgress, iterations, unproductive },
      limits,
    );

    switch (step.step) {
      case "complete":
        logger.info(
          `${def.name}: completion check passed — drain session complete ` +
            `(${iterations} iteration(s), filed ${filed.length})`,
        );
        return { status: "complete", iterations, filed };

      case "stop": {
        const reason =
          step.reason === "iteration-cap"
            ? `hit the iteration cap (${limits.maxIterations})`
            : def.doneWhen
              ? `${unproductive} iteration(s) filed nothing — what remains is likely in ` +
                `flight or in review. Re-run after PRs merge; the session resumes where ` +
                `the repo left off.`
              : `an iteration filed nothing — no work left to propose`;
        // Without a doneWhen, running dry IS the goal being met.
        const status = def.doneWhen ? "stopped" : "complete";
        const line = `${def.name}: drain session ${status} — ${reason}`;
        if (status === "complete") logger.info(line);
        else logger.warn(line);
        return { status, reason, iterations, filed, remaining: check?.output };
      }

      case "wait": {
        if (!waiting || Date.now() - lastWaitLog > WAIT_LOG_MS) {
          waiting = true;
          lastWaitLog = Date.now();
          logger.info(
            `${def.name}: ${inProgress} item(s) in progress (max ${limits.maxInProgress}); ` +
              `waiting for the executor to drain before proposing more`,
          );
        }
        await sleep(cfg.budget.pollSeconds * 1000);
        continue;
      }

      case "propose": {
        waiting = false;
        // Board context is best-effort: a tracker without listOpen just means
        // the agent leans on the dedup pass instead of seeing the list.
        const openItems = (await ports.tracker.listOpen?.().catch(() => null)) ?? [];
        const maxProposals = def.maxProposals ?? DEFAULT_DRAIN_MAX_PROPOSALS;
        const outcome = await proposerCycle(
          cfg,
          ports,
          { ...def, maxProposals },
          logger,
          {
            wipCap: limits.maxInProgress,
            extraContext: drainContext(def, check?.output, filed, openItems, maxProposals),
          },
        );

        if (outcome.status === "usage-limited") {
          const ms = backoffMs(outcome.resetAt, cfg.budget.backoffMinutes);
          logger.warn(
            `${def.name}: usage limited; drain session backing off ${Math.round(ms / 60_000)}m`,
          );
          await sleep(ms);
          continue; // not an iteration — nothing ran
        }
        if (outcome.status === "capped") {
          // The backlog cap, or an in-progress race lost since our own gate.
          // Either way the board must move before proposing helps; wait, don't
          // spend an iteration. Longer than the poll interval on purpose —
          // proposerCycle warns on every capped attempt, and a warn per poll
          // tick would drown the log while a human promotes the backlog.
          await sleep(cfg.budget.pollSeconds * 5_000);
          continue;
        }
        if (outcome.status === "error") {
          return {
            status: "error",
            reason: outcome.detail ?? "proposer cycle failed",
            iterations,
            filed,
            remaining: check?.output,
          };
        }

        iterations++;
        const created = outcome.created ?? [];
        filed.push(...created);
        unproductive = created.length === 0 ? unproductive + 1 : 0;
        logger.info(
          `${def.name}: drain iteration ${iterations}/${limits.maxIterations} — ` +
            `filed ${created.length} (session total ${filed.length})`,
        );
      }
    }
  }
}
