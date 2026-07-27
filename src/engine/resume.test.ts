import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementerCycle } from "./cycles.js";
import { MAX_RESUME_ATTEMPTS, resumeAttempts, setResumeAttempts } from "../util/state.js";
import type { AgentDef, CrewConfig, Logger, WorkItem } from "../types.js";
import type { Ports } from "./ports.js";

/**
 * These cover the "don't throw away verified work" path: when an agent has
 * committed and the commit passed verification, a later failure (push, PR,
 * unexpected error) must leave the worktree on disk so the next cycle can
 * retry landing it without paying for another agent run.
 */

const silent: Logger = { info() {}, warn() {}, error() {} };

const exec: AgentDef = {
  name: "implementer",
  kind: "executor",
  prompt: "impl",
  cadence: "continuous",
  builtin: true,
};

const item: WorkItem = {
  id: "i1",
  identifier: "ABC-1",
  title: "t",
  description: "",
  type: "task",
  stateName: "Todo",
  priority: 3,
  parentId: null,
  parentApproved: null,
  url: "",
  assigneeId: null,
  labels: [],
};

interface Sim {
  /** An existing worktree findWorktree should return. */
  existingWorktree?: string | null;
  hasCommits?: boolean;
  pushFails?: boolean;
  prFails?: boolean;
  verifyOk?: boolean;
}

interface Rec {
  removed: string[];
  pushed: number;
  agentRuns: number;
  created: number;
  transitions: string[];
  comments: string[];
}

function harness(sim: Sim = {}) {
  const rec: Rec = {
    removed: [],
    pushed: 0,
    agentRuns: 0,
    created: 0,
    transitions: [],
    comments: [],
  };
  const configDir = mkdtempSync(join(tmpdir(), "crew-resume-"));

  const cfg = {
    configDir,
    project: "p",
    repo: { path: "/repo", baseBranch: "main" },
    linear: {
      statuses: {
        backlog: "Backlog",
        ready: "Todo",
        inProgress: "In Progress",
        review: "In Review",
        needsApproval: "Needs Approval",
        done: "Done",
      },
      autoPromote: true,
    },
    gates: { noTouch: [], verify: {}, wipCap: 3 },
    models: { byComplexity: {}, default: undefined },
    triager: { backlogCap: 30 },
    personas: {},
  } as unknown as CrewConfig;

  const ports = {
    meta: { myUserId: "U" },
    agents: { implementer: exec },
    constitution: "c",
    linear: {
      selectNextExecutable: async () => item,
      transition: async (_id: string, to: string) => {
        rec.transitions.push(to);
      },
      assign: async () => {},
      addComment: async (_id: string, b: string) => {
        rec.comments.push(b);
      },
      findSimilarOpen: async () => [],
      createIssue: async () => {
        rec.created++;
        return item;
      },
      countBacklog: async () => 0,
    },
    git: {
      syncBase: async () => {},
      findWorktree: async () => sim.existingWorktree ?? null,
      createWorktree: async () => {
        rec.created++;
        return "/wt/fresh";
      },
      hasCommits: async () => sim.hasCommits ?? true,
      noTouchViolations: async () => [],
      changedApps: async () => [],
      push: async () => {
        rec.pushed++;
        if (sim.pushFails) throw new Error("push rejected");
      },
      openPr: async () => {
        if (sim.prFails) throw new Error("gh: PR creation failed");
        return "https://pr/1";
      },
      commentOnPr: async () => {},
      removeWorktree: async (p: string) => {
        rec.removed.push(p);
      },
    },
    persona: {
      run: async () => {
        rec.agentRuns++;
        return { summary: "did it", raw: "" };
      },
    },
  } as unknown as Ports;

  return { cfg, ports, rec, configDir };
}

// --------------------------- preserving on failure -------------------------

test("a push failure preserves the worktree instead of removing it", async () => {
  const { cfg, ports, rec } = harness({ pushFails: true });
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "error");
  assert.deepEqual(rec.removed, [], "worktree must NOT be removed");
});

test("a PR-creation failure preserves the worktree", async () => {
  const { cfg, ports, rec } = harness({ prFails: true });
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "error");
  assert.deepEqual(rec.removed, []);
});

test("a successful run still removes the worktree", async () => {
  const { cfg, ports, rec } = harness();
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "pr-opened");
  assert.deepEqual(rec.removed, ["/wt/fresh"]);
});

test("a run that produced no commit removes the worktree", async () => {
  const { cfg, ports, rec } = harness({ hasCommits: false });
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "no-commit");
  assert.deepEqual(rec.removed, ["/wt/fresh"], "nothing to preserve");
});

// --------------------------- resuming --------------------------------------

test("a preserved worktree is resumed WITHOUT re-running the agent", async () => {
  const { cfg, ports, rec } = harness({ existingWorktree: "/wt/kept" });
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "pr-opened");
  assert.equal(rec.agentRuns, 1, "only the post-PR self-review, not an implement run");
  assert.equal(rec.pushed, 1, "retried the push");
});

test("a successful resume clears the attempt counter and cleans up", async () => {
  const { cfg, ports, rec, configDir } = harness({ existingWorktree: "/wt/kept" });
  setResumeAttempts(configDir, "ABC-1", 2);
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "pr-opened");
  assert.equal(resumeAttempts(configDir, "ABC-1"), 0);
  assert.deepEqual(rec.removed, ["/wt/kept"]);
});

test("a failed resume increments the counter and keeps the worktree", async () => {
  const { cfg, ports, rec, configDir } = harness({
    existingWorktree: "/wt/kept",
    pushFails: true,
  });
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "error");
  assert.equal(resumeAttempts(configDir, "ABC-1"), 1);
  assert.deepEqual(rec.removed, []);
});

test("an existing worktree with no commits is not resumed", async () => {
  const { cfg, ports, rec } = harness({ existingWorktree: "/wt/empty", hasCommits: false });
  await implementerCycle(cfg, ports, silent);
  // Falls through to the fresh path: creates a new worktree and runs the agent.
  assert.ok(rec.agentRuns >= 1);
});

// --------------------------- retry cap -------------------------------------

test("resuming stops after MAX_RESUME_ATTEMPTS and discards the worktree", async () => {
  const { cfg, ports, rec, configDir } = harness({ existingWorktree: "/wt/kept" });
  setResumeAttempts(configDir, "ABC-1", MAX_RESUME_ATTEMPTS);
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "error");
  assert.match(out.detail ?? "", /exhausted/);
  assert.deepEqual(rec.removed, ["/wt/kept"], "gives up and cleans up");
  assert.equal(resumeAttempts(configDir, "ABC-1"), 0, "counter reset for a fresh start");
  assert.ok(rec.transitions.includes("Backlog"), "demoted for a human to look at");
  assert.ok(rec.comments.some((c) => /attempts/.test(c)));
});

test("the attempt counter survives an unrelated state write", async () => {
  const { configDir } = harness();
  setResumeAttempts(configDir, "ABC-1", 2);
  // Simulates the supervisor writing its own long-lived state object.
  const { readState, writeState } = await import("../util/state.js");
  const s = readState(configDir);
  writeState(configDir, { lastRun: { ...s.lastRun, qa: "now" } });
  assert.equal(resumeAttempts(configDir, "ABC-1"), 2);
});
