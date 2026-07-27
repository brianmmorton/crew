import { z } from "zod";

/**
 * The tracker block. Written as `tracker:`; the legacy `linear:` key parses
 * with this same shape and is folded into `tracker` at load time, so configs
 * written before Jira support keep working untouched.
 *
 * `team` means the Linear team name or the Jira project key, and `project`
 * means a Linear project or a Jira component — the two trackers name the same
 * two levels of nesting differently, so the neutral field carries both.
 */
export const trackerSchema = z.object({
  provider: z.enum(["linear", "jira"]).default("linear"),
  team: z.string().min(1),
  // Optional: scope this repo below the team (Linear project / Jira component)
  // so many repos can share one team and stay independent.
  project: z.string().optional(),
  labels: z
    .object({
      prd: z.string().default("type:prd"),
      bug: z.string().default("type:bug"),
      task: z.string().default("type:task"),
      chore: z.string().default("type:chore-dx"),
    })
    .default({}),
  statuses: z
    .object({
      backlog: z.string().default("Backlog"),
      ready: z.string().default("Todo"),
      inProgress: z.string().default("In Progress"),
      review: z.string().default("In Review"),
      needsApproval: z.string().default("Needs Approval"),
      done: z.string().default("Done"),
    })
    .default({}),
  approvedStates: z
    .array(z.string())
    .default(["Todo", "In Progress", "In Review", "Done"]),
  // Non-material proposals go straight to the ready state (executable). Set
  // false to stage them in Backlog for manual promotion instead.
  autoPromote: z.boolean().default(true),
  // Jira-only. Jira demands a real issue type on every create (Linear treats
  // the type as just a label), and its priority field can be disabled per
  // instance — both have to be configurable per project.
  jira: z
    .object({
      issueTypes: z
        .object({
          prd: z.string().default("Task"),
          bug: z.string().default("Bug"),
          task: z.string().default("Task"),
          chore: z.string().default("Task"),
        })
        .default({}),
      subtaskIssueType: z.string().optional(),
      usePriority: z.boolean().default(true),
      priorities: z
        .object({
          critical: z.string().default("Highest"),
          high: z.string().default("High"),
          medium: z.string().default("Medium"),
          low: z.string().default("Low"),
        })
        .default({}),
    })
    .default({}),
});

/** Zod schema for <crewDir>/config.yaml. Mirrors CrewConfig (minus resolved fields). */
export const configSchema = z.object({
  project: z.string().default("unnamed"),
  repo: z.object({
    path: z.string().default("."),
    baseBranch: z.string().default("main"),
  }),
  // Exactly one of these is required; `linear:` is the pre-Jira spelling and is
  // normalized into `tracker` by loadConfig(). Both are optional here so the
  // loader can raise a single clear error naming both spellings.
  tracker: trackerSchema.optional(),
  linear: trackerSchema.optional(),
  budget: z
    .object({
      target: z.enum(["max-monthly", "fixed"]).default("max-monthly"),
      implementerWorkers: z.number().int().min(1).max(8).default(1),
      backoffMinutes: z.number().int().min(1).default(30),
      pollSeconds: z.number().int().min(10).default(60),
    })
    .default({}),
  gates: z
    .object({
      wipCap: z.number().int().min(1).default(3),
      // Optional shell command to prepare the env before verify (e.g. activate a
      // runtime / install deps). Runs in the same shell as the verify commands.
      setup: z.string().optional(),
      verify: z.record(z.string()).default({}),
      noTouch: z
        .array(z.string())
        .default([".env*", "**/migrations/**", ".github/**"]),
    })
    .default({}),
  // Per-agent settings, keyed by persona name. Every key is optional: a persona
  // file with no entry here still works (see src/agent/agents.ts). The same
  // fields may be written as frontmatter in personas/<name>.md; this block wins.
  personas: z
    .record(
      z.object({
        // proposer (default) | executor | reviewer
        kind: z.enum(["proposer", "executor", "reviewer"]).optional(),
        cadence: z.string().optional(),
        model: z.string().optional(),
        description: z.string().optional(),
        // proposer/reviewer: restrict what it may file, and cap the volume.
        allowedTypes: z
          .array(z.enum(["prd", "bug", "task", "chore-dx", "spike"]))
          .optional(),
        maxProposals: z.number().int().min(1).optional(),
        // extra tracker label applied to everything this agent files
        label: z.string().optional(),
        // executor: labels this agent claims (unclaimed work → implementer)
        claims: z.array(z.string()).optional(),
        // reviewer: workflow states it may move an issue to (empty = comment only)
        canTransitionTo: z.array(z.string()).optional(),
      }),
    )
    .default({}),
  agent: z
    .object({
      // "claude" = built-in Claude Code adapter (streaming, subscription auth).
      // Anything else uses the generic command adapter below.
      provider: z.string().default("claude"),
      command: z.string().optional(), // CLI binary for non-claude providers
      args: z.array(z.string()).default([]), // base args before the prompt
      promptVia: z.enum(["stdin", "arg"]).default("stdin"),
      modelFlag: z.string().optional(), // how to pass the model, e.g. "--model"
    })
    .default({}),
  models: z
    .object({
      default: z.string().optional(),
      byComplexity: z
        .object({
          low: z.string().optional(),
          medium: z.string().optional(),
          high: z.string().optional(),
        })
        .default({}),
    })
    .default({}),
  triager: z
    .object({
      cadence: z.string().default("0 * * * *"),
      dedupThreshold: z.number().min(0).max(1).default(0.85),
      backlogCap: z.number().int().min(1).default(30),
      // How far back completed work still blocks a near-identical proposal.
      // Canceled work blocks regardless of age — see findSimilarOpen.
      dedupLookbackDays: z.number().int().min(0).default(30),
    })
    .default({}),
  // Pull proposers in early when the executor has nothing to do, instead of
  // leaving the team idle until the next cron tick.
  idle: z
    .object({
      enabled: z.boolean().default(true),
      // How long the executor must be continuously idle before triggering.
      afterMinutes: z.number().int().min(1).default(10),
      // Floor on how often any one proposer runs, across cron and idle alike.
      minIntervalMinutes: z.number().int().min(1).default(30),
      // Skip idle triggers while the backlog is this deep: work is already
      // waiting on a human to promote it, so proposing more doesn't help.
      maxBacklog: z.number().int().min(0).default(0),
      // Give up after this many consecutive idle runs that file nothing, until
      // something on the board actually changes.
      maxEmptyRuns: z.number().int().min(1).default(3),
      // Which proposers to pull in; empty = every scheduled proposer.
      agents: z.array(z.string()).default([]),
    })
    .default({}),
});

export type RawConfig = z.infer<typeof configSchema>;
