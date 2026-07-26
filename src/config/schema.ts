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
      verify: z.record(z.string()).default({}),
      noTouch: z
        .array(z.string())
        .default([".env*", "**/migrations/**", ".github/**"]),
    })
    .default({}),
  personas: z
    .record(z.object({ cadence: z.string(), model: z.string().optional() }))
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
