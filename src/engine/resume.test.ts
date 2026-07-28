import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { implementerCycle } from "./cycles.js";
import {
  MAX_RESUME_ATTEMPTS,
  MAX_VERIFY_ATTEMPTS,
  resumeAttempts,
  setResumeAttempts,
  setVerifyAttempts,
  verifyAttempts,
} from "../util/state.js";
import { acquireClaim, listClaims } from "./claim.js";
import { readVerifyFailure, writeVerifyFailure } from "../util/verifyfail.js";
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
  /** Labels added and removed across the cycle, in call order. */
  labelsAdded: string[];
  labelsRemoved: string[];
}

function harness(sim: Sim = {}) {
  const rec: Rec = {
    removed: [],
    pushed: 0,
    agentRuns: 0,
    created: 0,
    transitions: [],
    comments: [],
    labelsAdded: [],
    labelsRemoved: [],
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
      labels: {
        prd: "type:prd",
        bug: "type:bug",
        task: "type:task",
        chore: "type:chore-dx",
        stuck: "crew:stuck",
        needsHuman: "crew:needs-human",
      },
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
      setLabels: async (_id: string, c: { add?: string[]; remove?: string[] }) => {
        rec.labelsAdded.push(...(c.add ?? []));
        rec.labelsRemoved.push(...(c.remove ?? []));
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

test("a failed verify logs the failure and that a fix will be attempted", async () => {
  const { cfg, ports, rec } = harness({ verifyOk: false });
  const { logger, lines } = recordingLogger();
  const out = await implementerCycle(cfg, ports, logger);

  assert.equal(out.status, "verify-failed");
  // Not the backlog: the commit is kept so the agent can fix it next cycle.
  assert.ok(rec.transitions.includes("Todo"), "item returns to the ready state");
  assert.ok(!rec.transitions.includes("Backlog"), "work is not discarded on the first failure");

  const warns = lines.filter((l) => l.startsWith("WARN"));
  assert.ok(warns.some((l) => /verify gate failed/.test(l)), "names the failing gate");
  assert.ok(warns.some((l) => /can fix it/.test(l)), "says what happens next");
});

test("a failed verify exhausted of fix attempts demotes as before", async () => {
  const { cfg, ports, rec, configDir } = harness({ verifyOk: false });
  setVerifyAttempts(configDir, "ABC-1", MAX_VERIFY_ATTEMPTS);
  const { logger, lines } = recordingLogger();
  const out = await implementerCycle(cfg, ports, logger);

  assert.equal(out.status, "verify-failed");
  assert.ok(rec.transitions.includes("Backlog"), "falls back to the original behaviour");
  assert.equal(verifyAttempts(configDir, "ABC-1"), 0, "counter reset for a fresh start");
  const warns = lines.filter((l) => l.startsWith("WARN"));
  assert.ok(warns.some((l) => /returning to "Backlog"/.test(l)), "logs the demotion");
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
  // Exhausted fix attempts, so this failure really does discard the worktree.
  const { cfg, ports, freshWt, configDir } = harness({ verifyOk: false });
  setVerifyAttempts(configDir, "ABC-1", MAX_VERIFY_ATTEMPTS);
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

// --------------------------- claim release ---------------------------------

/**
 * The claim is what stops two workers taking one ticket, so it must be released
 * on EVERY exit path. A leaked claim outlives the cycle and blocks the ticket
 * until its owning process dies — which, for a long-lived supervisor, is never.
 */

test("a successful cycle releases its claim", async () => {
  const { cfg, ports, configDir } = harness();
  await implementerCycle(cfg, ports, silent);
  assert.deepEqual(listClaims(configDir), [], "claim must not outlive the cycle");
});

test("a failed push releases its claim", async () => {
  const { cfg, ports, configDir } = harness({ pushFails: true });
  await implementerCycle(cfg, ports, silent);
  assert.deepEqual(listClaims(configDir), []);
});

test("a failed verify releases its claim", async () => {
  const { cfg, ports, configDir } = harness({ verifyOk: false });
  await implementerCycle(cfg, ports, silent);
  assert.deepEqual(listClaims(configDir), []);
});

test("an item needing a human releases its claim", async () => {
  const { cfg, ports, configDir } = harness({ hasCommits: false, stray: strayWork });
  await implementerCycle(cfg, ports, silent);
  assert.deepEqual(listClaims(configDir), [], "the worktree is retained, but the claim is not");
});

test("a ticket already claimed by a live worker is skipped, not worked", async () => {
  const { cfg, ports, rec, configDir } = harness();
  assert.equal(acquireClaim(configDir, "ABC-1"), true, "simulate a sibling worker holding it");
  const out = await implementerCycle(cfg, ports, silent);
  // "contended", not "idle": there IS work, this worker just isn't doing it, so
  // the loop comes straight back instead of sleeping out a poll interval.
  assert.equal(out.status, "contended", "losing the race is not idleness");
  assert.equal(rec.agentRuns, 0, "must not run an agent on someone else's ticket");
  assert.deepEqual(rec.transitions, [], "must not touch the tracker either");
});

// --------------------------- lifecycle labels ------------------------------

/**
 * The board is where a person looks, so a cycle's disposition has to land
 * there — not only in a log line that scrolls away. `stuck` means the next
 * cycle can resume; `needs-human` means it must not.
 */

test("a push failure marks the item stuck so the next cycle resumes it", async () => {
  const { cfg, ports, rec } = harness({ pushFails: true });
  await implementerCycle(cfg, ports, silent);
  assert.ok(rec.labelsAdded.includes("crew:stuck"));
  assert.ok(rec.transitions.includes("Todo"), "and it returns to the ready state");
});

test("an escaped agent is marked needs-human, not stuck", async () => {
  const { cfg, ports, rec } = harness({ hasCommits: false, stray: strayWork });
  await implementerCycle(cfg, ports, silent);
  assert.ok(rec.labelsAdded.includes("crew:needs-human"));
  assert.ok(!rec.labelsAdded.includes("crew:stuck"), "must never invite an auto-resume");
});

test("a successful cycle clears both lifecycle labels", async () => {
  const { cfg, ports, rec } = harness();
  await implementerCycle(cfg, ports, silent);
  assert.ok(rec.labelsRemoved.includes("crew:stuck"));
  assert.ok(rec.labelsRemoved.includes("crew:needs-human"));
  assert.deepEqual(rec.labelsAdded, [], "a clean run marks nothing");
});

test("a successful resume clears the stuck label", async () => {
  const { cfg, ports, rec } = harness({ existingWorktree: "/wt/kept" });
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "pr-opened");
  assert.ok(rec.labelsRemoved.includes("crew:stuck"));
});

test("a demote clears the stuck label — it is a fresh start, not a resume", async () => {
  const { cfg, ports, rec, configDir } = harness({ verifyOk: false });
  setVerifyAttempts(configDir, "ABC-1", MAX_VERIFY_ATTEMPTS); // force the demote
  await implementerCycle(cfg, ports, silent);
  assert.ok(rec.labelsRemoved.includes("crew:stuck"));
});

test("a first verify failure marks the item stuck rather than clearing it", async () => {
  const { cfg, ports, rec } = harness({ verifyOk: false });
  await implementerCycle(cfg, ports, silent);
  assert.ok(rec.labelsAdded.includes("crew:stuck"), "the board shows a fix is pending");
});

test("a cycle whose tracker lacks setLabels still completes", async () => {
  const { cfg, ports } = harness();
  delete (ports.tracker as unknown as Record<string, unknown>).setLabels;
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "pr-opened", "labelling is an annotation, never a gate");
});

test("a failing setLabels does not fail the cycle", async () => {
  const { cfg, ports } = harness();
  (ports.tracker as unknown as Record<string, unknown>).setLabels = async () => {
    throw new Error("tracker rejected the label");
  };
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "pr-opened");
});

// --------------------------- verify fix-forward -----------------------------

/**
 * The whole point of fix-forward: a failing verify used to throw away a real
 * commit and send the ticket back to the backlog, so the next run paid an agent
 * to redo work it had already done. Now the commit and the failure that
 * rejected it are both kept, and the agent is sent back in to repair it.
 */

test("a failed verify preserves the worktree instead of discarding it", async () => {
  const { cfg, ports, rec } = harness({ verifyOk: false });
  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "verify-failed");
  assert.deepEqual(rec.removed, [], "the commit must survive for the agent to fix");
});

test("a failed verify records the output for the next cycle", async () => {
  const { cfg, ports, configDir } = harness({ verifyOk: false });
  await implementerCycle(cfg, ports, silent);
  const saved = readVerifyFailure(configDir, "ABC-1");
  assert.ok(saved, "the failure is persisted");
  assert.match(saved ?? "", /exit 1/, "and it holds the command that failed");
});

test("the next cycle re-runs the agent with the failure in its prompt", async () => {
  const { cfg, ports, configDir, freshWt } = harness({ verifyOk: false });
  await implementerCycle(cfg, ports, silent); // fails verify, preserves worktree

  // Second cycle: the worktree is found, and it carries a pending failure.
  const prompts: string[] = [];
  (ports.git as unknown as Record<string, unknown>).findWorktree = async () => freshWt;
  (ports.persona as unknown as Record<string, unknown>).run = async (
    _n: string,
    o: { prompt: string },
  ) => {
    prompts.push(o.prompt);
    return { summary: "fixed it", raw: "" };
  };

  await implementerCycle(cfg, ports, silent);
  const impl = prompts[0] ?? "";
  assert.match(impl, /fixing a failed verification/i, "the agent is told what it is doing");
  assert.match(impl, /exit 1/, "and shown the output that rejected its commit");
  assert.match(impl, /--amend/, "and told to amend rather than add a second commit");
  assert.equal(verifyAttempts(configDir, "ABC-1"), 1, "the attempt is counted");
});

test("a fix-forward does NOT push the commit verification rejected", async () => {
  const { cfg, ports, rec, freshWt } = harness({ verifyOk: false });
  await implementerCycle(cfg, ports, silent);
  (ports.git as unknown as Record<string, unknown>).findWorktree = async () => freshWt;

  await implementerCycle(cfg, ports, silent);
  assert.equal(rec.pushed, 0, "the rejected commit must never reach the remote");
});

test("a fix-forward that passes verify lands normally and clears its state", async () => {
  const { cfg, ports, rec, configDir, freshWt } = harness({ verifyOk: false });
  await implementerCycle(cfg, ports, silent);
  assert.ok(readVerifyFailure(configDir, "ABC-1"), "precondition: a fix is pending");

  // The agent's fix works, so verify passes this time.
  (ports.git as unknown as Record<string, unknown>).findWorktree = async () => freshWt;
  cfg.gates.verify = {};

  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "pr-opened");
  assert.equal(rec.pushed, 1);
  assert.equal(readVerifyFailure(configDir, "ABC-1"), null, "record cleared");
  assert.equal(verifyAttempts(configDir, "ABC-1"), 0, "counter cleared");
});

test("fix attempts are capped, then the work is discarded", async () => {
  const { cfg, ports, rec, configDir, freshWt } = harness({ verifyOk: false });
  (ports.git as unknown as Record<string, unknown>).findWorktree = async () =>
    readVerifyFailure(configDir, "ABC-1") ? freshWt : null;

  // Run until the cap is spent; every cycle fails verify.
  for (let i = 0; i < MAX_VERIFY_ATTEMPTS + 1; i++) {
    await implementerCycle(cfg, ports, silent);
  }

  assert.ok(rec.transitions.includes("Backlog"), "eventually gives up on the item");
  assert.ok(rec.removed.includes(freshWt), "and stops holding the pool slot");
  assert.equal(readVerifyFailure(configDir, "ABC-1"), null, "no stale record left behind");
  assert.equal(verifyAttempts(configDir, "ABC-1"), 0);
});

test("a counter left at the cap by a died cycle does not re-run the agent forever", async () => {
  // The backstop on the fix-forward entry check: normally the verify gate
  // spends the last attempt and demotes there, so this state only arises if a
  // cycle died before reaching the gate.
  const { cfg, ports, rec, configDir, freshWt } = harness({ verifyOk: false });
  writeVerifyFailure(configDir, "ABC-1", "an earlier failure");
  setVerifyAttempts(configDir, "ABC-1", MAX_VERIFY_ATTEMPTS);
  (ports.git as unknown as Record<string, unknown>).findWorktree = async () => freshWt;

  const out = await implementerCycle(cfg, ports, silent);
  assert.equal(out.status, "verify-failed");
  assert.match(out.detail ?? "", /exhausted/);
  assert.equal(rec.agentRuns, 0, "must not pay for another run");
  assert.ok(rec.removed.includes(freshWt), "and the slot is released");
  assert.equal(readVerifyFailure(configDir, "ABC-1"), null);
});

test("the fix-forward budget is separate from the push-retry budget", async () => {
  // A shared counter would let fix attempts exhaust the retries that landing
  // needs, so an item that finally goes green would have nothing left to push.
  const { cfg, ports, configDir } = harness({ verifyOk: false });
  setResumeAttempts(configDir, "ABC-1", 2);
  await implementerCycle(cfg, ports, silent);
  assert.equal(verifyAttempts(configDir, "ABC-1"), 0, "not yet consumed on the first failure");
  assert.equal(resumeAttempts(configDir, "ABC-1"), 2, "and landing's budget is untouched");
});

test("a demote clears any pending fix-forward record", async () => {
  const { cfg, ports, configDir } = harness({ hasCommits: false });
  writeVerifyFailure(configDir, "ABC-1", "stale failure from an older attempt");
  await implementerCycle(cfg, ports, silent);
  assert.equal(
    readVerifyFailure(configDir, "ABC-1"),
    null,
    "a record must never outlive the commit it describes",
  );
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

test("the attempt counters survive an unrelated state write", async () => {
  const { configDir } = harness();
  setResumeAttempts(configDir, "ABC-1", 2);
  setVerifyAttempts(configDir, "ABC-1", 1);
  // Simulates the supervisor writing its own long-lived state object. A lost
  // counter means an unbounded retry loop, so both must survive.
  const { readState, writeState } = await import("../util/state.js");
  const s = readState(configDir);
  writeState(configDir, { lastRun: { ...s.lastRun, qa: "now" } });
  assert.equal(resumeAttempts(configDir, "ABC-1"), 2);
  assert.equal(verifyAttempts(configDir, "ABC-1"), 1);
});

test("setting one attempt counter does not clobber the other", async () => {
  const { configDir } = harness();
  setResumeAttempts(configDir, "ABC-1", 2);
  setVerifyAttempts(configDir, "ABC-1", 1);
  setResumeAttempts(configDir, "ABC-1", 3);
  assert.equal(verifyAttempts(configDir, "ABC-1"), 1, "independent budgets stay independent");
});
