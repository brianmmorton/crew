import { z } from "zod";

/** Zod schema for <crewDir>/config.yaml. Mirrors CrewConfig (minus resolved fields). */
export const configSchema = z.object({
  project: z.string().default("unnamed"),
  repo: z.object({
    path: z.string().default("."),
    baseBranch: z.string().default("main"),
  }),
  linear: z.object({
    team: z.string().min(1),
    // Optional: scope this repo to a single Linear project (name or id) so many
    // repos can share one team on the free plan and stay independent.
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
  }),
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
        // extra Linear label applied to everything this agent files
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
    })
    .default({}),
});

export type RawConfig = z.infer<typeof configSchema>;
