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
  /** Work found in the MAIN checkout — an agent that escaped its worktree. */
  stray?: { commits: string[]; dirtyFiles: string[] };
  /** The user's own uncommitted work, present before the run starts. */
  preexistingDirty?: string[];
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
  // Verify commands really run, so the fresh worktree must be a real directory
  // when a test exercises the gate. Other tests never chdir into it.
  const freshWt = sim.verifyOk === false ? mkdtempSync(join(tmpdir(), "crew-wt-")) : "/wt/fresh";

  const cfg = {
    configDir,
    project: "p",
    repo: { path: "/repo", baseBranch: "main" },
    tracker: {
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
    // `verifyOk: false` needs a real command so runVerify has a gate to fail;
    // `exit 1` is the cheapest portable one.
    gates: {
      noTouch: [],
      verify: sim.verifyOk === false ? { app: "exit 1" } : {},
      wipCap: 3,
    },
    models: { byComplexity: {}, default: undefined },
    triager: { backlogCap: 30 },
    personas: {},
  } as unknown as CrewConfig;

  const ports = {
    meta: { myUserId: "U" },
    agents: { implementer: exec },
    constitution: "c",
    tracker: {
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
        return freshWt;
      },
      hasCommits: async () => sim.hasCommits ?? true,
      checkoutSnapshot: async () => ({ head: "h0", dirty: sim.preexistingDirty ?? [] }),
      strayWork: async () => sim.stray ?? { commits: [], dirtyFiles: [] },
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

  return { cfg, ports, rec, configDir, freshWt };
}

/** Collects every level into one list, so a test can assert on what was logged. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (m) => lines.push(`INFO ${m}`),
      warn: (m) => lines.push(`WARN ${m}`),
      error: (m) => lines.push(`ERROR ${m}`),
    },
  };
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

// --------------------------- verbose failure logging ------------------------

/**
 * The bug these cover: a failed verify demoted the item, deleted the worktree,
 * and returned — writing nothing to the log. The only trace was a tracker
 * comment, so the run read as a success. Every lifecycle step must now say what
 * it did and why.
 */

test("a failed verify logs the failure, the reason, and the demotion", async () => {
  const { cfg, ports, rec } = harness({ verifyOk: false });
  const { logger, lines } = recordingLogger();
  const out = await implementerCycle(cfg, ports, logger);

  assert.equal(out.status, "verify-failed");
  assert.ok(rec.transitions.includes("Backlog"), "item went back to the backlog");

  const warns = lines.filter((l) => l.startsWith("WARN"));
  assert.ok(warns.some((l) => /verify gate failed/.test(l)), "names the failing gate");
  assert.ok(warns.some((l) => /returning to "Backlog"/.test(l)), "logs the demotion");
  assert.ok(
    warns.some((l) => /verification failed/.test(l)),
    "includes the reason posted to the tracker",
  );
});

test("a failed verify reports its output in the cycle detail", async () => {
  const { cfg, ports } = harness({ verifyOk: false });
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "verify-failed");
  assert.match(out.detail ?? "", /exit 1/, "detail carries the command that failed");
});

test("gates that pass are logged too, so the lifecycle is traceable", async () => {
  const { cfg, ports } = harness();
  const { logger, lines } = recordingLogger();
  await implementerCycle(cfg, ports, logger);

  for (const step of [/commit present/, /no-touch gate passed/, /verify gate passed/, /pushing/]) {
    assert.ok(lines.some((l) => step.test(l)), `missing a log line matching ${step}`);
  }
});

test("worktree removal is announced rather than happening silently", async () => {
  const { cfg, ports, freshWt } = harness({ verifyOk: false });
  const { logger, lines } = recordingLogger();
  await implementerCycle(cfg, ports, logger);
  assert.ok(
    lines.some((l) => l.includes("removing worktree") && l.includes(freshWt)),
    "the deleted worktree path is named in the log",
  );
});

test("a no-commit run logs why the item was demoted", async () => {
  const { cfg, ports } = harness({ hasCommits: false });
  const { logger, lines } = recordingLogger();
  const out = await implementerCycle(cfg, ports, logger);
  assert.equal(out.status, "no-commit");
  assert.ok(lines.some((l) => /WARN.*produced no commit/.test(l)));
});

// --------------------- agent escaped its worktree ---------------------------

/**
 * The failure this prevents: an agent `cd`s into the main checkout (usually
 * because the repo's AGENTS.md hardcodes an absolute path) and commits there.
 * The worktree branch is empty, so the cycle reported "no commit", demoted the
 * ticket, and deleted the worktree — while the real work sat on the user's
 * checkout, unmentioned.
 */

const strayWork = { commits: ["abc123 docs: cache architecture"], dirtyFiles: [] };

test("work committed in the main checkout is detected instead of reported as no-commit", async () => {
  const { cfg, ports } = harness({ hasCommits: false, stray: strayWork });
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "error");
  assert.match(out.detail ?? "", /outside its worktree/);
});

test("an escaped agent's worktree is NOT deleted", async () => {
  const { cfg, ports, rec } = harness({ hasCommits: false, stray: strayWork });
  await implementerCycle(cfg, ports, silent);
  assert.deepEqual(rec.removed, [], "nothing may be discarded while work is unaccounted for");
});

test("an escaped agent does not silently demote the ticket to the backlog", async () => {
  const { cfg, ports, rec } = harness({ hasCommits: false, stray: strayWork });
  await implementerCycle(cfg, ports, silent);
  assert.ok(!rec.transitions.includes("Backlog"), "must not recycle work that needs a human");
});

test("the escape is logged as an error naming the main checkout", async () => {
  const { cfg, ports } = harness({ hasCommits: false, stray: strayWork });
  const { logger, lines } = recordingLogger();
  await implementerCycle(cfg, ports, logger);
  const errors = lines.filter((l) => l.startsWith("ERROR"));
  assert.ok(errors.some((l) => /worked OUTSIDE its worktree/.test(l)));
  assert.ok(errors.some((l) => l.includes("/repo")), "names where the stray work landed");
  assert.ok(errors.some((l) => /abc123/.test(l)), "shows the stray commit");
});

test("the ticket gets a comment explaining the escape", async () => {
  const { cfg, ports, rec } = harness({ hasCommits: false, stray: strayWork });
  await implementerCycle(cfg, ports, silent);
  assert.ok(rec.comments.some((c) => /outside its worktree/.test(c)));
});

test("uncommitted stray changes also count as work worth preserving", async () => {
  const { cfg, ports, rec } = harness({
    hasCommits: false,
    stray: { commits: [], dirtyFiles: ["M src/a.ts", "?? docs/b.md"] },
  });
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "error");
  assert.deepEqual(rec.removed, []);
});

test("a genuinely empty run still demotes and cleans up as before", async () => {
  const { cfg, ports, rec } = harness({ hasCommits: false });
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "no-commit", "no stray work means the old behaviour is correct");
  assert.deepEqual(rec.removed, ["/wt/fresh"]);
  assert.ok(rec.transitions.includes("Backlog"));
});

test("a GitPort without strayWork support falls back to plain no-commit", async () => {
  const { cfg, ports, rec } = harness({ hasCommits: false });
  // Older/alternative adapters may not implement the optional diagnostic.
  delete (ports.git as unknown as Record<string, unknown>).strayWork;
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "no-commit");
  assert.deepEqual(rec.removed, ["/wt/fresh"]);
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
