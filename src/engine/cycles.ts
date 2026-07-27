import type { CrewConfig, Logger, PersonaName, Proposal } from "../types.js";
import type { Ports } from "./ports.js";
import { runVerify } from "../gates/gates.js";
import {
  buildImplementerPrompt,
  buildProposerPrompt,
  buildReflectionPrompt,
  prBody,
  tail,
} from "./context.js";
import { extractProposalsJson } from "../personas/parse.js";
import { withHeartbeat } from "../util/heartbeat.js";
import { writeRunLog } from "../util/runlog.js";
import type { Complexity, CrewConfig as _Cfg } from "../types.js";

/** Pick the implementer model for an item's complexity, falling back sensibly. */
function modelForComplexity(cfg: _Cfg, complexity: Complexity | null | undefined): string | undefined {
  const byC = complexity ? cfg.models.byComplexity[complexity] : undefined;
  return byC || cfg.models.default || cfg.personas.implementer?.model || undefined;
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
 * One Implementer cycle: claim the next executable issue, implement it in an
 * isolated worktree, gate on no-touch + verify, and open a PR. The engine —
 * not the agent — owns every Linear transition and the git/PR work.
 */
export async function implementerCycle(
  cfg: CrewConfig,
  ports: Ports,
  logger: Logger,
): Promise<CycleOutcome> {
  const item = await ports.linear.selectNextExecutable();
  if (!item) return { status: "idle" };

  const branch = `agent/${item.identifier.toLowerCase()}`;
  const S = cfg.linear.statuses;
  logger.info(`implementer claimed ${item.identifier}`, { title: item.title });

  await ports.linear.transition(item.id, S.inProgress);
  await ports.linear.assign(item.id, ports.meta.myUserId);

  let wt: string | undefined;
  const demote = async (note: string) => {
    await ports.linear.addComment(item.id, `crew: ${note}`);
    await ports.linear.transition(item.id, S.backlog);
  };

  try {
    await ports.git.syncBase();
    wt = await ports.git.createWorktree(branch);

    const prompt = buildImplementerPrompt(
      cfg,
      ports.prompts.implementer ?? "",
      ports.constitution,
      item,
    );
    const model = modelForComplexity(cfg, item.complexity);
    logger.info(
      `implementer ${item.identifier}: working (complexity=${item.complexity ?? "?"}, model=${model ?? "default"})…`,
    );
    const worktree = wt;
    const res = await withHeartbeat(logger, `implementer ${item.identifier}`, () =>
      ports.persona.run("implementer", {
        cwd: worktree,
        prompt,
        model,
        expectJson: false,
        onActivity: (line) => logger.info(`  ${item.identifier} ${line}`),
      }),
    );
    const runLog = writeRunLog(cfg.configDir, `implementer-${item.identifier}`, res.raw ?? res.summary ?? "");
    if (runLog) logger.info(`implementer ${item.identifier}: full run output → ${runLog}`);

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
    logger.info(`implementer opened PR for ${item.identifier}`, { url });

    await reflect(cfg, ports, wt, logger).catch((e) =>
      logger.warn("reflection failed (non-fatal)", { error: String(e) }),
    );

    return { status: "pr-opened", url };
  } catch (e) {
    logger.error(`implementer cycle error on ${item.identifier}`, { error: String(e) });
    try {
      await ports.linear.transition(item.id, S.ready);
      await ports.linear.assign(item.id, null);
    } catch {
      /* best effort */
    }
    return { status: "error", detail: String(e) };
  } finally {
    if (wt) await ports.git.removeWorktree(wt).catch(() => {});
  }
}

/** Self-review: file DX friction as chore-dx items (deduped). */
async function reflect(
  cfg: CrewConfig,
  ports: Ports,
  wt: string,
  logger: Logger,
): Promise<void> {
  const res = await ports.persona.run("implementer", {
    cwd: wt,
    prompt: buildReflectionPrompt(),
    model: cfg.personas.implementer?.model,
    expectJson: true,
  });
  const parsed = res.friction ?? extractFriction(res.raw ?? "");
  for (const p of parsed) {
    if ((await ports.linear.findSimilarOpen(p.title)).length) continue;
    await ports.linear.createIssue(
      { ...p, type: "chore-dx", isMaterial: false },
      { author: "implementer" },
    );
    logger.info(`self-review filed DX item: ${p.title}`);
  }
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
  name: PersonaName,
  logger: Logger,
): Promise<CycleOutcome> {
  if ((await ports.linear.countBacklog()) >= cfg.triager.backlogCap) {
    logger.warn(`${name}: backlog at cap (${cfg.triager.backlogCap}); not filing new items`);
    return { status: "capped" };
  }

  const prompt = buildProposerPrompt(cfg, ports.prompts[name] ?? "", ports.constitution, name);
  logger.info(`${name}: starting run (headless Claude analyzes the repo; this can take a minute)…`);
  const res = await withHeartbeat(logger, name, () =>
    ports.persona.run(name, {
      cwd: cfg.repo.path,
      prompt,
      model: cfg.personas[name]?.model,
      expectJson: true,
      onActivity: (line) => logger.info(`  ${name} ${line}`),
    }),
  );
  const runLog = writeRunLog(cfg.configDir, name, res.raw ?? "");
  if (runLog) logger.info(`${name}: full run output → ${runLog}`);
  if (res.usageLimited) return { status: "usage-limited", resetAt: res.resetAt ?? null };

  const created: string[] = [];
  for (const p of res.proposals ?? []) {
    if ((await ports.linear.findSimilarOpen(p.title)).length) {
      logger.info(`${name}: skipping duplicate "${p.title}"`);
      continue;
    }
    const material = p.isMaterial === true;
    const proposal: Proposal = material ? { ...p, type: "prd" } : p;
    const item = await ports.linear.createIssue(proposal, {
      author: name,
      needsApproval: material,
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
