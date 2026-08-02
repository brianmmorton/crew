import type {
  AgentDef,
  CrewConfig,
  Logger,
  PersonaName,
  Proposal,
  ReviewOutcome,
  WorkItem,
} from "../types.js";
import type { Ports } from "./ports.js";
import { runVerify } from "../gates/gates.js";
import {
  buildImplementerPrompt,
  buildProposerPrompt,
  buildReflectionPrompt,
  buildReviewerPrompt,
  prBody,
  tail,
} from "./context.js";
import { extractProposalsJson } from "../personas/parse.js";
import { withHeartbeat } from "../util/heartbeat.js";
import { basename } from "node:path";
import { amendRun, recordRun, trimReason } from "../util/runlog.js";
import { style } from "../util/color.js";
import { agentsOfKind, executorFor } from "../agent/agents.js";
import {
  MAX_RESUME_ATTEMPTS,
  MAX_VERIFY_ATTEMPTS,
  resumeAttempts,
  setResumeAttempts,
  setVerifyAttempts,
  verifyAttempts,
} from "../util/state.js";
import {
  clearVerifyFailure,
  readVerifyFailure,
  writeVerifyFailure,
} from "../util/verifyfail.js";
import { acquireClaim, releaseClaim } from "./claim.js";
import type { Complexity, CrewConfig as _Cfg } from "../types.js";

/** How long to wait for a pooled worktree slot before giving the item back. */
const SLOT_WAIT_MS = 5 * 60 * 1000;
const SLOT_POLL_MS = 5_000;

/**
 * Get a worktree, waiting when the pool is momentarily full.
 *
 * Waiting (rather than creating an overflow worktree) is what makes
 * `worktrees.max` a real bound — and on the large repos this feature exists for,
 * an unbounded pool means unbounded disk. A slot held by a *retained* worktree
 * won't free on its own, though, so exhaustion that is entirely retention is
 * reported as the stall it is instead of being waited out.
 */
async function acquireWorktree(
  ports: Ports,
  branch: string,
  identifier: string,
  logger: Logger,
): Promise<string> {
  const deadline = Date.now() + SLOT_WAIT_MS;
  let waited = false;
  const observed = ports.git as { onPoolEvent?: unknown };
  if ("onPoolEvent" in observed) {
    observed.onPoolEvent = (e: { slot: number; how: string; ms: number }) =>
      logger.info(
        `${identifier}: worktree slot-${e.slot} ready via ${e.how} in ${(e.ms / 1000).toFixed(1)}s`,
      );
  }
  for (;;) {
    try {
      const wt = await ports.git.createWorktree(branch);
      if (waited) logger.info(`${identifier}: got a worktree slot`);
      return wt;
    } catch (e) {
      const exhausted = e instanceof Error && e.name === "PoolExhaustedError";
      if (!exhausted) throw e;

      const { retained = 0, busy = 0 } = e as Error & { retained?: number; busy?: number };
      if (busy === 0) {
        // Nothing is going to free up: every slot holds work that failed to land
        // or needs a human. Waiting the full timeout would just delay the report.
        throw new Error(
          `every worktree slot is retained (${retained}) — each holds a verified commit ` +
            `that could not be pushed, or work that needs a human. Resolve those branches ` +
            `(or raise worktrees.max) before more work can run. Run \`crew worktrees\` to inspect.`,
        );
      }
      if (Date.now() >= deadline) throw e;
      if (!waited) {
        waited = true;
        logger.info(
          `${identifier}: all worktree slots are in use (busy=${busy}, retained=${retained}); waiting…`,
        );
      }
      await new Promise((r) => setTimeout(r, SLOT_POLL_MS));
    }
  }
}

/**
 * How the user checks their code-host credentials, named for the forge they
 * actually configured — a Bitbucket user has no `gh` to run.
 */
function authHint(cfg: CrewConfig): string {
  return cfg.repo.forge === "bitbucket"
    ? "your Bitbucket credentials (`crew doctor`)"
    : "`gh auth status`";
}

/**
 * Pick the model for an item's complexity. An agent's own `model` wins (you
 * chose it deliberately for that agent), then the complexity map, then the
 * global default.
 */
function modelForComplexity(
  cfg: _Cfg,
  complexity: Complexity | null | undefined,
  agent?: AgentDef | null,
): string | undefined {
  if (agent?.model) return agent.model;
  const byC = complexity ? cfg.models.byComplexity[complexity] : undefined;
  return byC || cfg.models.default || undefined;
}

/**
 * Enforce an agent's declared limits on what it filed. The prompt asks for
 * these too, but a prompt is not a guarantee — this is, so a misbehaving or
 * hallucinating custom agent can't flood the backlog or file types it was
 * never granted.
 */
export function enforceLimits(
  agent: AgentDef,
  proposals: Proposal[],
  logger?: Logger,
): Proposal[] {
  let out = proposals;

  if (agent.allowedTypes?.length) {
    const allowed = new Set<string>(agent.allowedTypes);
    const kept = out.filter((p) => allowed.has(p.type));
    if (kept.length !== out.length && logger) {
      logger.warn(
        `${agent.name}: dropped ${out.length - kept.length} proposal(s) with a type it may not file ` +
          `(allowed: ${agent.allowedTypes.join(", ")})`,
      );
    }
    out = kept;
  }

  if (agent.maxProposals && out.length > agent.maxProposals) {
    logger?.warn(
      `${agent.name}: capped at maxProposals=${agent.maxProposals} (returned ${out.length})`,
    );
    out = out.slice(0, agent.maxProposals);
  }

  return out;
}

export type CycleStatus =
  | "idle"
  /** Another worker holds the item. There IS work — just not for us. */
  | "contended"
  | "pr-opened"
  | "no-commit"
  | "rejected"
  | "verify-failed"
  | "usage-limited"
  | "proposed"
  | "capped"
  | "error";

export interface CycleOutcome {
  status: CycleStatus;
  resetAt?: string | null;
  url?: string;
  created?: string[];
  detail?: string;
}

/**
 * One executor cycle: claim the next executable issue, route it to the executor
 * agent that claims its labels (falling back to `implementer`), implement it in
 * an isolated worktree, gate on no-touch + verify, and open a PR. The engine —
 * not the agent — owns every tracker transition and the git/PR work.
 */
export async function implementerCycle(
  cfg: CrewConfig,
  ports: Ports,
  logger: Logger,
): Promise<CycleOutcome> {
  const item = await ports.tracker.selectNextExecutable();
  if (!item) return { status: "idle" };

  // Claim the ticket before touching it. `selectNextExecutable` is a
  // read-then-write against a tracker with no compare-and-set, so two workers
  // can return the same item; the claim decides which one actually works it.
  // Losing is normal, not an error — but it is NOT idle either: there is work,
  // this worker just isn't the one doing it, so the loop should come straight
  // back rather than sleeping out a poll interval.
  if (!acquireClaim(cfg.configDir, item.identifier)) {
    logger.info(`${item.identifier}: claimed by another worker; skipping`);
    return { status: "contended", detail: item.identifier };
  }

  try {
    return await workClaimedItem(cfg, ports, item, logger);
  } finally {
    releaseClaim(cfg.configDir, item.identifier);
  }
}

/**
 * The body of one executor cycle, for an item this worker holds the claim on.
 * Split from `implementerCycle` purely so the claim's release is a single
 * `finally` around every exit path, including the throwing ones.
 */
async function workClaimedItem(
  cfg: CrewConfig,
  ports: Ports,
  item: WorkItem,
  logger: Logger,
): Promise<CycleOutcome> {
  const all = Object.values(ports.agents);
  const exec = executorFor(all, item.labels);
  if (!exec) {
    logger.error(
      `no executor agent defined (expected ${cfg.configDir}/personas/implementer.md); ` +
        `cannot work ${item.identifier}`,
    );
    return { status: "error", detail: "no executor agent" };
  }

  const branch = `agent/${item.identifier.toLowerCase()}`;
  const S = cfg.tracker.statuses;
  logger.info(`${exec.name} claimed ${item.identifier}`, { title: item.title });

  await ports.tracker.transition(item.id, S.inProgress);
  await ports.tracker.assign(item.id, ports.meta.myUserId);

  let wt: string | undefined;
  /**
   * Set when the worktree holds a verified commit that failed to land. The
   * `finally` block leaves it on disk so the next cycle resumes from it instead
   * of throwing the work away and paying an agent to redo it.
   */
  let preserve: string | null = null;
  /**
   * On a fix-forward run, the verify output that rejected the existing commit.
   * Null on a fresh run. Drives both the prompt and whether a worktree is
   * acquired — a fix-forward reuses the one already holding the work.
   */
  let fixing: string | null = null;

  // Lifecycle labels are optional in practice: a config predating them, or a
  // tracker adapter without label support, must still run the cycle. An unset
  // name simply means that mark is not applied.
  const L: Partial<Record<"stuck" | "needsHuman", string>> = cfg.tracker.labels ?? {};
  /**
   * Record the cycle's disposition on the tracker. This is what makes a failure
   * visible to a person on the board rather than only in a log line, and what
   * tells the next cycle whether an item is resumable.
   *
   * Never fatal: the work itself already succeeded or failed on its own terms,
   * and losing the annotation must not also lose the outcome.
   */
  const label = async (
    add: (string | undefined)[],
    remove: (string | undefined)[] = [],
  ) => {
    const names = (xs: (string | undefined)[]) => xs.filter((x): x is string => !!x);
    const [a, r] = [names(add), names(remove)];
    if (!a.length && !r.length) return;
    await ports.tracker
      .setLabels?.(item.id, { add: a, remove: r })
      .catch((e) =>
        logger.warn(`${item.identifier}: could not update labels`, { error: String(e) }),
      );
  };
  /** Mark resumable: the next cycle continues from the preserved worktree. */
  const markStuck = () => label([L.stuck]);
  /** Mark as needing a person. Recovery skips these permanently. */
  const markNeedsHuman = () => label([L.needsHuman], [L.stuck]);
  /** Clear both lifecycle labels — the item is healthy again. */
  const clearMarks = () => label([], [L.stuck, L.needsHuman]);

  /**
   * Send an item back to the backlog with an explanation. The same explanation
   * goes to the log as a warning: a demote is always a failure, and reading the
   * tracker comment should never be the only way to find out why.
   *
   * A demote is a fresh start — the worktree is discarded — so any `stuck` mark
   * from an earlier attempt is cleared with it.
   */
  const demote = async (reason: string, note: string) => {
    logger.warn(`${exec.name} ${item.identifier}: ${reason} — returning to "${S.backlog}"`);
    for (const line of note.split("\n")) {
      logger.warn(`  ${item.identifier} ${style("│", "dim")} ${line}`);
    }
    await ports.tracker.addComment(item.id, `crew: ${note}`);
    await ports.tracker.transition(item.id, S.backlog);
    await clearMarks();
    // A demote discards the worktree, so any pending fix-forward record would
    // otherwise outlive the commit it describes and mis-route the next cycle.
    clearVerifyFailure(cfg.configDir, item.identifier);
  };

  try {
    await ports.git.syncBase();

    const existing = await ports.git.findWorktree(branch);
    const hasExisting = !!existing && (await ports.git.hasCommits(existing).catch(() => false));

    // Fix-forward path: the previous attempt committed but failed verification.
    // The commit is NOT good, so this re-runs the agent against its own code
    // and the output that rejected it — much cheaper than starting over, and
    // the failing test is exactly the input needed to fix it.
    const pendingFix = hasExisting ? readVerifyFailure(cfg.configDir, item.identifier) : null;
    if (existing && pendingFix) {
      const tries = verifyAttempts(cfg.configDir, item.identifier) + 1;
      // Normally the verify gate below spends the last attempt and demotes
      // there, so this is a backstop rather than the usual exit: it catches a
      // counter left at the cap by a cycle that died before reaching the gate
      // (or by a hand-edited state file), which would otherwise re-run the
      // agent forever.
      if (tries > MAX_VERIFY_ATTEMPTS) {
        logger.error(
          `${item.identifier}: giving up after ${MAX_VERIFY_ATTEMPTS} attempt(s) to fix the failing ` +
            `verify; discarding the worktree`,
        );
        setVerifyAttempts(cfg.configDir, item.identifier, 0);
        clearVerifyFailure(cfg.configDir, item.identifier);
        await ports.git.removeWorktree(existing).catch(() => {});
        await demote(
          `exhausted ${MAX_VERIFY_ATTEMPTS} attempt(s) to fix a failing verify`,
          `verification still failed after ${MAX_VERIFY_ATTEMPTS} fix attempt(s); the work was ` +
            `discarded.\n\n\`\`\`\n${tail(pendingFix, 1500)}\n\`\`\``,
        );
        return { status: "verify-failed", detail: "verify fix attempts exhausted" };
      }

      setVerifyAttempts(cfg.configDir, item.identifier, tries);
      logger.info(
        `${item.identifier}: re-running the agent to fix a failed verify ` +
          `(attempt ${tries}/${MAX_VERIFY_ATTEMPTS})`,
      );
      // Reuse the worktree in place — its commit is what the agent repairs —
      // and fall through to the shared implement-and-gate flow below.
      wt = existing;
      fixing = pendingFix;
    }

    // Resume path: a previous cycle committed and verified this item but failed
    // to push or open the PR. The commit is already good, so retry just the
    // plumbing — no agent run, no tokens.
    // `!fixing` matters: a fix-forward worktree also has a commit, but that
    // commit is the one verification rejected. Landing it would push work the
    // gate already refused.
    if (existing && hasExisting && !fixing) {
      const attempts = resumeAttempts(cfg.configDir, item.identifier) + 1;
      if (attempts > MAX_RESUME_ATTEMPTS) {
        logger.error(
          `${item.identifier}: giving up after ${MAX_RESUME_ATTEMPTS} failed attempts to land the ` +
            `existing commit; discarding the worktree for a fresh start`,
        );
        setResumeAttempts(cfg.configDir, item.identifier, 0);
        await ports.git.removeWorktree(existing).catch(() => {});
        await demote(
          `exhausted ${MAX_RESUME_ATTEMPTS} attempts to land the existing commit`,
          `could not push/open a PR after ${MAX_RESUME_ATTEMPTS} attempts. The work was ` +
            `discarded — please check ${authHint(cfg)} and the branch \`${branch}\`.`,
        );
        return { status: "error", detail: "resume attempts exhausted" };
      }

      setResumeAttempts(cfg.configDir, item.identifier, attempts);
      logger.info(
        `${item.identifier}: resuming a preserved worktree (attempt ${attempts}/${MAX_RESUME_ATTEMPTS}) — ` +
          `the commit already exists, retrying push/PR only`,
      );
      wt = existing;
      preserve = existing; // keep it if this attempt fails too
      const out = await landCommit(cfg, ports, exec, item, wt, branch, logger);
      if (out.status === "pr-opened") {
        setResumeAttempts(cfg.configDir, item.identifier, 0);
        preserve = null;
        await clearMarks(); // landed at last — no longer stuck
      }
      return out;
    }

    // A fix-forward already has its worktree (and its pool slot); only a fresh
    // run needs to claim one.
    if (!wt) wt = await acquireWorktree(ports, branch, item.identifier, logger);
    // Hold a fix-forward worktree through the run: dropping it on a failure
    // would discard the very commit the agent was asked to repair.
    if (fixing) preserve = wt;

    // Baseline of the user's checkout, taken immediately before the agent runs.
    // The user is normally on a feature branch with their own uncommitted work,
    // so only a change relative to THIS is attributable to the agent.
    const before = await ports.git.checkoutSnapshot?.().catch(() => null);

    const prompt = buildImplementerPrompt(
      cfg,
      exec.prompt,
      ports.constitution,
      item,
      wt,
      fixing ?? undefined,
    );
    const model = modelForComplexity(cfg, item.complexity, exec);
    logger.info(
      `${exec.name} ${item.identifier}: working (complexity=${item.complexity ?? "?"}, model=${model ?? "default"})…`,
    );
    const worktree = wt;
    const startedAt = Date.now();
    const res = await withHeartbeat(logger, `${exec.name} ${item.identifier}`, () =>
      ports.persona.run(exec.name, {
        cwd: worktree,
        prompt,
        model,
        expectJson: false,
        onActivity: (line) => logger.info(`  ${item.identifier} ${line}`),
      }),
    );
    const runLog = recordRun(
      cfg.configDir,
      `${exec.name}-${item.identifier}`,
      res.raw ?? res.summary ?? "",
      {
        kind: "implement",
        agent: exec.name,
        item: item.identifier,
        title: item.title,
        outcome: res.usageLimited ? "usage-limited" : "ok",
        ms: Date.now() - startedAt,
        model: model ?? undefined,
      },
    );
    if (runLog) logger.info(`${exec.name} ${item.identifier}: full run output → ${runLog}`);

    if (res.usageLimited) {
      // Put the issue back so it's picked up again after the window reopens.
      await ports.tracker.transition(item.id, S.ready);
      await ports.tracker.assign(item.id, null);
      return { status: "usage-limited", resetAt: res.resetAt ?? null };
    }

    if (!(await ports.git.hasCommits(wt))) {
      // "No commit on the branch" has two very different causes: the agent
      // genuinely did nothing, or it worked outside its worktree and the commit
      // landed somewhere else. Only the first is safe to shrug off, so find out
      // which before touching anything.
      const stray = before ? await ports.git.strayWork?.(before).catch(() => null) : null;
      if (stray && (stray.commits.length || stray.dirtyFiles.length)) {
        const what = [
          stray.commits.length ? `${stray.commits.length} commit(s)` : "",
          stray.dirtyFiles.length ? `${stray.dirtyFiles.length} uncommitted file(s)` : "",
        ]
          .filter(Boolean)
          .join(" and ");
        logger.error(
          `${exec.name} ${item.identifier}: the agent worked OUTSIDE its worktree — ` +
            `${what} appeared in the main checkout at ${cfg.repo.path} during this run, ` +
            `while its worktree branch stayed empty.`,
        );
        for (const c of stray.commits.slice(0, 10)) logger.error(`  ${item.identifier} │ ${c}`);
        for (const f of stray.dirtyFiles.slice(0, 20)) logger.error(`  ${item.identifier} │ ${f}`);
        logger.error(
          `${item.identifier}: leaving the worktree at ${wt} and NOT discarding anything. ` +
            `Move that work onto \`${branch}\` (or reset your checkout) before re-running. ` +
            `A repo AGENTS.md that hardcodes an absolute path is the usual cause.`,
        );
        // Preserve the worktree and leave the item in progress: this needs a
        // human, and silently recycling it would invite the same escape again.
        preserve = wt;
        await ports.tracker.addComment(
          item.id,
          `crew: the agent committed outside its worktree — ${what} are in the main checkout ` +
            `(${cfg.repo.path}) instead of on \`${branch}\`. Nothing was discarded; this needs a human.`,
        );
        await markNeedsHuman();
        return { status: "error", detail: "agent worked outside its worktree" };
      }

      await demote("the agent produced no commit", `no commit produced. ${res.summary ?? ""}`.trim());
      return { status: "no-commit" };
    }
    logger.info(`${exec.name} ${item.identifier}: commit present — running gates`);

    const violations = await ports.git.noTouchViolations(wt, cfg.gates.noTouch);
    if (violations.length) {
      await demote(
        `no-touch gate failed (${violations.length} protected path(s))`,
        `rejected — touched protected paths:\n${violations.join("\n")}`,
      );
      recordRun(cfg.configDir, `notouch-${item.identifier}`, violations.join("\n"), {
        kind: "verify",
        agent: exec.name,
        item: item.identifier,
        title: item.title,
        outcome: "rejected",
        reason: trimReason(`touched protected paths: ${violations.join(", ")}`),
      });
      return { status: "rejected", detail: violations.join(", ") };
    }
    logger.info(`${exec.name} ${item.identifier}: no-touch gate passed`);

    const apps = await ports.git.changedApps(wt, Object.keys(cfg.gates.verify));
    logger.info(
      `${exec.name} ${item.identifier}: verify gate starting ` +
        `(changed apps: ${apps.length ? apps.join(", ") : "none detected — running all"})`,
    );
    const verify = await runVerify(cfg, wt, apps);
    // Verify output is the single most useful artifact when a cycle dies, so it
    // is always persisted — pass or fail — and its path is always logged.
    const verifyLog = recordRun(
      cfg.configDir,
      `verify-${item.identifier}${verify.ok ? "" : "-FAILED"}`,
      verify.output,
      {
        kind: "verify",
        agent: exec.name,
        item: item.identifier,
        title: item.title,
        outcome: verify.ok ? "ok" : "failed",
        // The failing tail is the whole point of the history pane for a broken
        // run — persist it so reading "why" doesn't mean opening the log.
        reason: verify.ok ? undefined : trimReason(verify.output),
      },
    );
    if (!verify.ok) {
      if (verifyLog) logger.warn(`${item.identifier}: full verify output → ${verifyLog}`);
      const spent = verifyAttempts(cfg.configDir, item.identifier);
      if (spent >= MAX_VERIFY_ATTEMPTS) {
        // Out of fix attempts: fall back to the original behaviour — discard
        // the work and put the item back for a human or a fresh start.
        setVerifyAttempts(cfg.configDir, item.identifier, 0);
        clearVerifyFailure(cfg.configDir, item.identifier);
        // Release the hold taken for the fix-forward run, or the `finally` would
        // retain this slot forever on the one path that gives up on the work.
        preserve = null;
        await demote(
          "verify gate failed",
          `verification failed.\n\n\`\`\`\n${tail(verify.output)}\n\`\`\``,
        );
        return { status: "verify-failed", detail: tail(verify.output, 400) };
      }

      // Keep the commit and the failure that rejected it, so the next cycle can
      // hand both back to the agent instead of paying for a fresh run.
      writeVerifyFailure(cfg.configDir, item.identifier, verify.output);
      preserve = wt;
      logger.warn(
        `${exec.name} ${item.identifier}: verify gate failed — keeping the worktree so the agent ` +
          `can fix it (attempt ${spent + 1}/${MAX_VERIFY_ATTEMPTS} next cycle)`,
      );
      await ports.tracker.addComment(
        item.id,
        `crew: verification failed; the agent will attempt a fix.\n\n\`\`\`\n${tail(verify.output, 1500)}\n\`\`\``,
      );
      await ports.tracker.transition(item.id, S.ready);
      await ports.tracker.assign(item.id, null);
      await markStuck();
      return { status: "verify-failed", detail: tail(verify.output, 400) };
    }
    logger.info(
      `${exec.name} ${item.identifier}: verify gate passed` +
        (verifyLog ? ` (output → ${verifyLog})` : ""),
    );
    // Green — any earlier fix-forward state is spent.
    clearVerifyFailure(cfg.configDir, item.identifier);
    setVerifyAttempts(cfg.configDir, item.identifier, 0);

    // From here the commit is verified, so any failure preserves the worktree.
    preserve = wt;
    const out = await landCommit(cfg, ports, exec, item, wt, branch, logger);
    if (out.status === "pr-opened") {
      preserve = null;
      await clearMarks();
    }
    return out;
  } catch (e) {
    logger.error(`${exec.name} cycle error on ${item.identifier}`, { error: String(e) });
    // A cycle that dies here produced no run log of its own, so without this
    // the failure is invisible in the history pane — the one place a user
    // looks to find out why a sequence stopped.
    recordRun(cfg.configDir, `error-${item.identifier}`, String(e), {
      kind: "implement",
      agent: exec.name,
      item: item.identifier,
      title: item.title,
      outcome: "failed",
      reason: trimReason(String(e)),
    });
    // A verified commit exists but something after it blew up — keep the
    // worktree so the next cycle can retry landing it.
    const resumable = !!wt && (await ports.git.hasCommits(wt).catch(() => false));
    if (resumable) preserve = wt as string;
    try {
      await ports.tracker.transition(item.id, S.ready);
      await ports.tracker.assign(item.id, null);
      // Back in the ready state, so `selectNextExecutable` finds it again. The
      // label is what tells the next cycle this is a resume: without it, an
      // item that returns to ready looks identical to fresh work.
      if (resumable) await markStuck();
    } catch {
      /* best effort */
    }
    return { status: "error", detail: String(e) };
  } finally {
    if (wt && wt !== preserve) {
      logger.info(`${item.identifier}: removing worktree ${wt} (branch ${branch})`);
      await ports.git
        .removeWorktree(wt)
        .catch((e) =>
          logger.warn(`${item.identifier}: worktree cleanup failed`, { path: wt, error: String(e) }),
        );
    } else if (preserve) {
      // Under pooling this is what keeps the slot out of circulation; unpooled
      // it's a no-op, because there "preserved" just means "not removed".
      await ports.git.retainWorktree?.(preserve).catch((e) =>
        logger.warn(`${item.identifier}: could not mark the worktree as retained`, {
          path: preserve,
          error: String(e),
        }),
      );
      logger.warn(
        `${item.identifier}: kept the worktree at ${preserve} (branch ${branch}) — ` +
          `it holds a verified commit. The next cycle will retry push/PR without re-running the agent.`,
      );
    }
  }
}

/**
 * Land an already-verified commit: push, open the PR, move the issue, then run
 * reviewers and self-review. Shared by the fresh path and the resume path, so a
 * retry does exactly what the original attempt would have done.
 *
 * Throws on push/PR failure — the caller preserves the worktree and retries.
 */
async function landCommit(
  cfg: CrewConfig,
  ports: Ports,
  exec: AgentDef,
  item: WorkItem,
  wt: string,
  branch: string,
  logger: Logger,
): Promise<CycleOutcome> {
  const S = cfg.tracker.statuses;

  logger.info(`${exec.name} ${item.identifier}: pushing ${branch}…`);
  await ports.git.push(wt, branch);
  logger.info(`${exec.name} ${item.identifier}: pushed; opening PR against ${cfg.repo.baseBranch}…`);
  const url = await ports.git.openPr({
    repoPath: cfg.repo.path,
    branch,
    baseBranch: cfg.repo.baseBranch,
    title: item.title,
    body: prBody(item),
    assignee: "@me",
    label: "agent-authored",
  });

  await ports.tracker.transition(item.id, S.review);
  await ports.tracker.assign(item.id, ports.meta.myUserId);
  await ports.tracker.addComment(item.id, `crew: PR opened → ${url}`);
  logger.info(`${exec.name} opened PR for ${item.identifier}`, { url });

  // Record the PR against the item itself, so it shows in history even when
  // no reviewers are configured (the reviewer records carry it otherwise).
  recordRun(cfg.configDir, `pr-${item.identifier}`, url, {
    kind: "implement",
    agent: exec.name,
    item: item.identifier,
    title: item.title,
    outcome: "ok",
    prUrl: url,
  });

  // Reviewers run against the pushed branch, before the worktree is removed.
  logger.info(`${item.identifier}: review stage starting`);
  await runReviewers(cfg, ports, wt, item, url, logger).catch((e) =>
    logger.warn(`${item.identifier}: review stage failed (non-fatal)`, { error: String(e) }),
  );
  logger.info(`${item.identifier}: review stage done`);

  logger.info(`${item.identifier}: self-review (reflection) starting`);
  await reflect(cfg, ports, wt, exec, logger).catch((e) =>
    logger.warn(`${item.identifier}: reflection failed (non-fatal)`, { error: String(e) }),
  );
  logger.info(`${item.identifier}: self-review done`);

  return { status: "pr-opened", url };
}

/** Self-review: file DX friction as chore-dx items (deduped). */
async function reflect(
  cfg: CrewConfig,
  ports: Ports,
  wt: string,
  exec: AgentDef,
  logger: Logger,
): Promise<void> {
  const res = await ports.persona.run(exec.name, {
    cwd: wt,
    prompt: buildReflectionPrompt(),
    model: exec.model,
    expectJson: true,
  });
  const parsed = res.friction ?? extractFriction(res.raw ?? "");
  for (const p of parsed) {
    if ((await ports.tracker.findSimilarOpen(p.title)).length) continue;
    await ports.tracker.createIssue(
      { ...p, type: "chore-dx", isMaterial: false },
      { author: exec.name },
    );
    logger.info(`self-review filed DX item: ${p.title}`);
  }
}

/**
 * Apply one reviewer's verdict. The reviewer returns JSON and this function is
 * the only thing that acts on it, so every side effect is enforced in one
 * place: a transition outside `canTransitionTo` is refused and logged.
 */
export async function applyReview(
  cfg: CrewConfig,
  ports: Ports,
  agent: AgentDef,
  item: WorkItem,
  prUrl: string,
  review: ReviewOutcome,
  logger: Logger,
): Promise<void> {
  if (review.prComment?.trim()) {
    await ports.git
      .commentOnPr(prUrl, `**${agent.name}** review:\n\n${review.prComment.trim()}`)
      .catch((e) => logger.warn(`${agent.name}: PR comment failed`, { error: String(e) }));
  }

  if (review.issueComment?.trim()) {
    await ports.tracker
      .addComment(item.id, `crew (${agent.name}): ${review.issueComment.trim()}`)
      .catch((e) => logger.warn(`${agent.name}: issue comment failed`, { error: String(e) }));
  }

  const to = review.transitionTo?.trim();
  if (to) {
    const allowed = agent.canTransitionTo ?? [];
    if (!allowed.includes(to)) {
      logger.warn(
        `${agent.name}: refused transition to "${to}" — not in canTransitionTo ` +
          `[${allowed.join(", ") || "none"}]`,
      );
    } else {
      await ports.tracker.transition(item.id, to);
      logger.info(`${agent.name}: moved ${item.identifier} → ${to}`);
      // Moving an item back to the ready state makes it executable again, so
      // the executor will rework it on the next tick. That's the intended
      // "needs rework" flow, but if the reviewer objects again it can cycle —
      // so it's called out loudly rather than silently burning usage.
      if (to === cfg.tracker.statuses.ready) {
        logger.warn(
          `${agent.name}: ${item.identifier} is back in "${to}" and will be reworked ` +
            `by the executor. If this repeats, the PR is looping — intervene by hand.`,
        );
      }
    }
  }
}

/**
 * Run every reviewer agent against a freshly-opened PR, in name order. Each
 * reviewer is independent and non-fatal: one failing never blocks the others
 * or the PR itself.
 */
async function runReviewers(
  cfg: CrewConfig,
  ports: Ports,
  wt: string,
  item: WorkItem,
  prUrl: string,
  logger: Logger,
): Promise<void> {
  const reviewers = agentsOfKind(Object.values(ports.agents), "reviewer").sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (!reviewers.length) return;

  for (const rev of reviewers) {
    try {
      logger.info(`${rev.name}: reviewing ${item.identifier}…`);
      const revStartedAt = Date.now();
      const res = await withHeartbeat(logger, `${rev.name} ${item.identifier}`, () =>
        ports.persona.run(rev.name, {
          cwd: wt,
          prompt: buildReviewerPrompt(cfg, rev, ports.constitution, item, prUrl),
          model: rev.model ?? cfg.models.default,
          expectJson: true,
          onActivity: (line) => logger.info(`  ${rev.name} ${line}`),
        }),
      );
      const revLog = recordRun(cfg.configDir, `${rev.name}-${item.identifier}`, res.raw ?? "", {
        kind: "review",
        agent: rev.name,
        item: item.identifier,
        title: item.title,
        outcome: res.usageLimited ? "usage-limited" : "ok",
        ms: Date.now() - revStartedAt,
        model: rev.model ?? cfg.models.default,
        prUrl,
      });
      if (revLog) logger.info(`${rev.name} ${item.identifier}: full run output → ${revLog}`);
      if (res.usageLimited) {
        logger.warn(`${rev.name}: usage limited; skipping review`);
        continue;
      }

      const parsed = res.review ?? extractReview(res.raw ?? "");
      // No parse means the reviewer's verdict was silently dropped. That is a
      // real failure of the stage, not a no-op, so it is never swallowed.
      if (!parsed) {
        logger.warn(
          `${rev.name}: returned no parseable review verdict for ${item.identifier}; ` +
            `no transition or comment was applied` + (revLog ? ` (raw output → ${revLog})` : ""),
        );
      }
      if (parsed) await applyReview(cfg, ports, rev, item, prUrl, parsed, logger);

      // A reviewer may also file follow-up work. This mirrors proposerCycle:
      // same limits, same material gate, same auto-promote behaviour — so a
      // material follow-up lands in Needs Approval assigned to the human (who
      // the tracker then notifies) rather than sitting unassigned and unseen.
      const follow = enforceLimits(rev, res.proposals ?? extractProposals(res.raw ?? ""), logger);
      for (const p of follow) {
        if ((await ports.tracker.findSimilarOpen(p.title)).length) continue;
        const material = p.isMaterial === true;
        const created = await ports.tracker.createIssue(
          material ? { ...p, type: "prd" } : p,
          { author: rev.name, needsApproval: material, label: rev.label },
        );
        if (material) {
          await ports.tracker.assign(created.id, ports.meta.myUserId);
        } else if (cfg.tracker.autoPromote) {
          await ports.tracker.transition(created.id, cfg.tracker.statuses.ready);
        }
        logger.info(`${rev.name} filed follow-up ${created.identifier}`, {
          title: p.title,
          material,
        });
      }
      logger.info(`${rev.name}: review of ${item.identifier} done`, {
        verdict: parsed?.verdict ?? "none",
      });
    } catch (e) {
      logger.warn(`${rev.name}: review failed (non-fatal)`, { error: String(e) });
    }
  }
}

/** Pull a ReviewOutcome out of a reviewer's free-form output. */
function extractReview(raw: string): ReviewOutcome | null {
  const parsed = extractProposalsJson(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const verdict = str(parsed.verdict);
  return {
    verdict:
      verdict === "approve" || verdict === "comment" || verdict === "changes-requested"
        ? verdict
        : undefined,
    prComment: str(parsed.prComment),
    issueComment: str(parsed.issueComment),
    transitionTo: str(parsed.transitionTo),
  };
}

/** Pull a proposals array out of free-form output (shared by reviewers). */
function extractProposals(raw: string): Proposal[] {
  const parsed = extractProposalsJson(raw) as
    | { proposals?: Proposal[] }
    | Proposal[]
    | null;
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  return parsed.proposals ?? [];
}

function extractFriction(raw: string): Proposal[] {
  const parsed = extractProposalsJson(raw) as { friction?: Proposal[] } | Proposal[] | null;
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  return parsed.friction ?? [];
}

/**
 * One proposer cycle (QA / Design / Architect): produce proposals, dedup them
 * against open issues, and create issues — material ones become PRDs in Needs
 * Approval, assigned to you so the tracker notifies you.
 */
export async function proposerCycle(
  cfg: CrewConfig,
  ports: Ports,
  agent: AgentDef | PersonaName,
  logger: Logger,
  opts?: {
    /**
     * Replaces gates.wipCap for THIS cycle's in-progress gate. A drain session
     * (see engine/drain.ts) owns its own concurrency bound, and the global cap
     * silently shadowing a larger per-agent one would be a config mystery.
     */
    wipCap?: number;
    /** Appended to the built prompt — drain sessions pass what remains. */
    extraContext?: string;
  },
): Promise<CycleOutcome> {
  const def = typeof agent === "string" ? ports.agents[agent] : agent;
  if (!def) {
    logger.error(`unknown agent "${String(agent)}" — no ${cfg.configDir}/personas/${String(agent)}.md`);
    return { status: "error", detail: "unknown agent" };
  }
  const name = def.name;

  if ((await ports.tracker.countBacklog()) >= cfg.triager.backlogCap) {
    logger.warn(`${name}: backlog at cap (${cfg.triager.backlogCap}); not filing new items`);
    return { status: "capped" };
  }

  // The executor is saturated, so anything filed now just queues up behind work
  // that's already waiting. Skip the run rather than burn tokens deepening a
  // backlog nobody is draining.
  const wipCap = opts?.wipCap ?? cfg.gates.wipCap;
  if ((await ports.tracker.countInProgress()) >= wipCap) {
    logger.warn(
      `${name}: executor at WIP cap (${wipCap} in "${cfg.tracker.statuses.inProgress}"); ` +
        `not filing new items`,
    );
    return { status: "capped" };
  }

  const prompt =
    buildProposerPrompt(cfg, def.prompt, ports.constitution, def) +
    (opts?.extraContext ? `\n\n${opts.extraContext}` : "");
  logger.info(`${name}: starting run (a headless agent analyzes the repo; this can take a minute)…`);
  const startedAt = Date.now();
  const res = await withHeartbeat(logger, name, () =>
    ports.persona.run(name, {
      cwd: cfg.repo.path,
      prompt,
      model: def.model ?? cfg.models.default,
      expectJson: true,
      onActivity: (line) => logger.info(`  ${name} ${line}`),
    }),
  );
  const runLog = recordRun(cfg.configDir, name, res.raw ?? "", {
    kind: "propose",
    agent: name,
    outcome: res.usageLimited ? "usage-limited" : "ok",
    ms: Date.now() - startedAt,
    model: def.model ?? cfg.models.default,
  });
  if (runLog) logger.info(`${name}: full run output → ${runLog}`);
  if (res.usageLimited) return { status: "usage-limited", resetAt: res.resetAt ?? null };

  const created: string[] = [];
  for (const p of enforceLimits(def, res.proposals ?? [], logger)) {
    if ((await ports.tracker.findSimilarOpen(p.title)).length) {
      logger.info(`${name}: skipping duplicate "${p.title}"`);
      continue;
    }
    const material = p.isMaterial === true;
    const proposal: Proposal = material ? { ...p, type: "prd" } : p;
    const item = await ports.tracker.createIssue(proposal, {
      author: name,
      needsApproval: material,
      label: def.label,
    });
    if (material) {
      await ports.tracker.assign(item.id, ports.meta.myUserId);
    } else if (cfg.tracker.autoPromote) {
      await ports.tracker.transition(item.id, cfg.tracker.statuses.ready);
    }
    created.push(item.identifier);
    const where = material ? " (PRD, needs approval)" : cfg.tracker.autoPromote ? " → Todo" : " → Backlog";
    logger.info(`${name} filed ${item.identifier}${where}`, { title: p.title });
    if ((await ports.tracker.countBacklog()) >= cfg.triager.backlogCap) break;
  }

  // The tickets are the proposer's whole output, but they don't exist until
  // now — amend the index line written above rather than delaying it.
  if (created.length && runLog) amendRun(cfg.configDir, basename(runLog), { created });

  return { status: "proposed", created };
}
