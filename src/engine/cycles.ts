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
import { writeRunLog } from "../util/runlog.js";
import { agentsOfKind, executorFor } from "../agent/agents.js";
import { MAX_RESUME_ATTEMPTS, resumeAttempts, setResumeAttempts } from "../util/state.js";
import type { Complexity, CrewConfig as _Cfg } from "../types.js";

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
 * not the agent — owns every Linear transition and the git/PR work.
 */
export async function implementerCycle(
  cfg: CrewConfig,
  ports: Ports,
  logger: Logger,
): Promise<CycleOutcome> {
  const item = await ports.linear.selectNextExecutable();
  if (!item) return { status: "idle" };

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
  const S = cfg.linear.statuses;
  logger.info(`${exec.name} claimed ${item.identifier}`, { title: item.title });

  await ports.linear.transition(item.id, S.inProgress);
  await ports.linear.assign(item.id, ports.meta.myUserId);

  let wt: string | undefined;
  /**
   * Set when the worktree holds a verified commit that failed to land. The
   * `finally` block leaves it on disk so the next cycle resumes from it instead
   * of throwing the work away and paying an agent to redo it.
   */
  let preserve: string | null = null;
  const demote = async (note: string) => {
    await ports.linear.addComment(item.id, `crew: ${note}`);
    await ports.linear.transition(item.id, S.backlog);
  };

  try {
    await ports.git.syncBase();

    // Resume path: a previous cycle committed and verified this item but failed
    // to push or open the PR. The commit is already good, so retry just the
    // plumbing — no agent run, no tokens.
    const existing = await ports.git.findWorktree(branch);
    if (existing && (await ports.git.hasCommits(existing).catch(() => false))) {
      const attempts = resumeAttempts(cfg.configDir, item.identifier) + 1;
      if (attempts > MAX_RESUME_ATTEMPTS) {
        logger.error(
          `${item.identifier}: giving up after ${MAX_RESUME_ATTEMPTS} failed attempts to land the ` +
            `existing commit; discarding the worktree for a fresh start`,
        );
        setResumeAttempts(cfg.configDir, item.identifier, 0);
        await ports.git.removeWorktree(existing).catch(() => {});
        await demote(
          `could not push/open a PR after ${MAX_RESUME_ATTEMPTS} attempts. The work was ` +
            `discarded — please check \`gh auth status\` and the branch \`${branch}\`.`,
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
      }
      return out;
    }

    wt = await ports.git.createWorktree(branch);

    const prompt = buildImplementerPrompt(cfg, exec.prompt, ports.constitution, item);
    const model = modelForComplexity(cfg, item.complexity, exec);
    logger.info(
      `${exec.name} ${item.identifier}: working (complexity=${item.complexity ?? "?"}, model=${model ?? "default"})…`,
    );
    const worktree = wt;
    const res = await withHeartbeat(logger, `${exec.name} ${item.identifier}`, () =>
      ports.persona.run(exec.name, {
        cwd: worktree,
        prompt,
        model,
        expectJson: false,
        onActivity: (line) => logger.info(`  ${item.identifier} ${line}`),
      }),
    );
    const runLog = writeRunLog(cfg.configDir, `${exec.name}-${item.identifier}`, res.raw ?? res.summary ?? "");
    if (runLog) logger.info(`${exec.name} ${item.identifier}: full run output → ${runLog}`);

    if (res.usageLimited) {
      // Put the issue back so it's picked up again after the window reopens.
      await ports.linear.transition(item.id, S.ready);
      await ports.linear.assign(item.id, null);
      return { status: "usage-limited", resetAt: res.resetAt ?? null };
    }

    if (!(await ports.git.hasCommits(wt))) {
      await demote(`no commit produced. ${res.summary ?? ""}`.trim());
      return { status: "no-commit" };
    }

    const violations = await ports.git.noTouchViolations(wt, cfg.gates.noTouch);
    if (violations.length) {
      await demote(`rejected — touched protected paths:\n${violations.join("\n")}`);
      return { status: "rejected", detail: violations.join(", ") };
    }

    const apps = await ports.git.changedApps(wt, Object.keys(cfg.gates.verify));
    const verify = await runVerify(cfg, wt, apps);
    if (!verify.ok) {
      await demote(`verification failed.\n\n\`\`\`\n${tail(verify.output)}\n\`\`\``);
      return { status: "verify-failed" };
    }

    // From here the commit is verified, so any failure preserves the worktree.
    preserve = wt;
    const out = await landCommit(cfg, ports, exec, item, wt, branch, logger);
    if (out.status === "pr-opened") preserve = null;
    return out;
  } catch (e) {
    logger.error(`${exec.name} cycle error on ${item.identifier}`, { error: String(e) });
    // A verified commit exists but something after it blew up — keep the
    // worktree so the next cycle can retry landing it.
    if (wt && (await ports.git.hasCommits(wt).catch(() => false))) preserve = wt;
    try {
      await ports.linear.transition(item.id, S.ready);
      await ports.linear.assign(item.id, null);
    } catch {
      /* best effort */
    }
    return { status: "error", detail: String(e) };
  } finally {
    if (wt && wt !== preserve) {
      await ports.git.removeWorktree(wt).catch(() => {});
    } else if (preserve) {
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
  const S = cfg.linear.statuses;

  await ports.git.push(wt, branch);
  const url = await ports.git.openPr({
    repoPath: cfg.repo.path,
    branch,
    baseBranch: cfg.repo.baseBranch,
    title: item.title,
    body: prBody(item),
    assignee: "@me",
    label: "agent-authored",
  });

  await ports.linear.transition(item.id, S.review);
  await ports.linear.assign(item.id, ports.meta.myUserId);
  await ports.linear.addComment(item.id, `crew: PR opened → ${url}`);
  logger.info(`${exec.name} opened PR for ${item.identifier}`, { url });

  // Reviewers run against the pushed branch, before the worktree is removed.
  await runReviewers(cfg, ports, wt, item, url, logger).catch((e) =>
    logger.warn("review stage failed (non-fatal)", { error: String(e) }),
  );

  await reflect(cfg, ports, wt, exec, logger).catch((e) =>
    logger.warn("reflection failed (non-fatal)", { error: String(e) }),
  );

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
    if ((await ports.linear.findSimilarOpen(p.title)).length) continue;
    await ports.linear.createIssue(
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
    await ports.linear
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
      await ports.linear.transition(item.id, to);
      logger.info(`${agent.name}: moved ${item.identifier} → ${to}`);
      // Moving an item back to the ready state makes it executable again, so
      // the executor will rework it on the next tick. That's the intended
      // "needs rework" flow, but if the reviewer objects again it can cycle —
      // so it's called out loudly rather than silently burning usage.
      if (to === cfg.linear.statuses.ready) {
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
      const res = await withHeartbeat(logger, `${rev.name} ${item.identifier}`, () =>
        ports.persona.run(rev.name, {
          cwd: wt,
          prompt: buildReviewerPrompt(cfg, rev, ports.constitution, item, prUrl),
          model: rev.model ?? cfg.models.default,
          expectJson: true,
          onActivity: (line) => logger.info(`  ${rev.name} ${line}`),
        }),
      );
      writeRunLog(cfg.configDir, `${rev.name}-${item.identifier}`, res.raw ?? "");
      if (res.usageLimited) {
        logger.warn(`${rev.name}: usage limited; skipping review`);
        continue;
      }

      const parsed = res.review ?? extractReview(res.raw ?? "");
      if (parsed) await applyReview(cfg, ports, rev, item, prUrl, parsed, logger);

      // A reviewer may also file follow-up work. This mirrors proposerCycle:
      // same limits, same material gate, same auto-promote behaviour — so a
      // material follow-up lands in Needs Approval assigned to the human (who
      // Linear then notifies) rather than sitting unassigned and unseen.
      const follow = enforceLimits(rev, res.proposals ?? extractProposals(res.raw ?? ""), logger);
      for (const p of follow) {
        if ((await ports.linear.findSimilarOpen(p.title)).length) continue;
        const material = p.isMaterial === true;
        const created = await ports.linear.createIssue(
          material ? { ...p, type: "prd" } : p,
          { author: rev.name, needsApproval: material, label: rev.label },
        );
        if (material) {
          await ports.linear.assign(created.id, ports.meta.myUserId);
        } else if (cfg.linear.autoPromote) {
          await ports.linear.transition(created.id, cfg.linear.statuses.ready);
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
 * Approval, assigned to you so Linear notifies you.
 */
export async function proposerCycle(
  cfg: CrewConfig,
  ports: Ports,
  agent: AgentDef | PersonaName,
  logger: Logger,
): Promise<CycleOutcome> {
  const def = typeof agent === "string" ? ports.agents[agent] : agent;
  if (!def) {
    logger.error(`unknown agent "${String(agent)}" — no ${cfg.configDir}/personas/${String(agent)}.md`);
    return { status: "error", detail: "unknown agent" };
  }
  const name = def.name;

  if ((await ports.linear.countBacklog()) >= cfg.triager.backlogCap) {
    logger.warn(`${name}: backlog at cap (${cfg.triager.backlogCap}); not filing new items`);
    return { status: "capped" };
  }

  // The executor is saturated, so anything filed now just queues up behind work
  // that's already waiting. Skip the run rather than burn tokens deepening a
  // backlog nobody is draining.
  if ((await ports.linear.countInProgress()) >= cfg.gates.wipCap) {
    logger.warn(
      `${name}: executor at WIP cap (${cfg.gates.wipCap} in "${cfg.linear.statuses.inProgress}"); ` +
        `not filing new items`,
    );
    return { status: "capped" };
  }

  const prompt = buildProposerPrompt(cfg, def.prompt, ports.constitution, def);
  logger.info(`${name}: starting run (a headless agent analyzes the repo; this can take a minute)…`);
  const res = await withHeartbeat(logger, name, () =>
    ports.persona.run(name, {
      cwd: cfg.repo.path,
      prompt,
      model: def.model ?? cfg.models.default,
      expectJson: true,
      onActivity: (line) => logger.info(`  ${name} ${line}`),
    }),
  );
  const runLog = writeRunLog(cfg.configDir, name, res.raw ?? "");
  if (runLog) logger.info(`${name}: full run output → ${runLog}`);
  if (res.usageLimited) return { status: "usage-limited", resetAt: res.resetAt ?? null };

  const created: string[] = [];
  for (const p of enforceLimits(def, res.proposals ?? [], logger)) {
    if ((await ports.linear.findSimilarOpen(p.title)).length) {
      logger.info(`${name}: skipping duplicate "${p.title}"`);
      continue;
    }
    const material = p.isMaterial === true;
    const proposal: Proposal = material ? { ...p, type: "prd" } : p;
    const item = await ports.linear.createIssue(proposal, {
      author: name,
      needsApproval: material,
      label: def.label,
    });
    if (material) {
      await ports.linear.assign(item.id, ports.meta.myUserId);
    } else if (cfg.linear.autoPromote) {
      await ports.linear.transition(item.id, cfg.linear.statuses.ready);
    }
    created.push(item.identifier);
    const where = material ? " (PRD, needs approval)" : cfg.linear.autoPromote ? " → Todo" : " → Backlog";
    logger.info(`${name} filed ${item.identifier}${where}`, { title: p.title });
    if ((await ports.linear.countBacklog()) >= cfg.triager.backlogCap) break;
  }

  return { status: "proposed", created };
}
