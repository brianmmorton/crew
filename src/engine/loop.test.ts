import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrewConfig, Logger, WorkItem } from "../types.js";
import type { Ports } from "./ports.js";
import {
  backoffMs,
  requestStop,
  resetStop,
  runExecutorLoop,
  setIdleHandler,
  wakeExecutor,
} from "./loop.js";

/**
 * These cover what changes when `implementerWorkers > 1`: N workers draining
 * one board, coordinating only through the per-item claim. The failure this
 * guards is two workers taking the same ticket — the tracker cannot arbitrate,
 * so nothing but the claim stops it.
 */

const silent: Logger = { info() {}, warn() {}, error() {} };

function cfgWith(workers: number, configDir: string): CrewConfig {
  return {
    configDir,
    project: "p",
    repo: { path: "/repo", baseBranch: "main" },
    budget: { implementerWorkers: workers, pollSeconds: 0.01, backoffMinutes: 1 },
    worktrees: { reuse: true, max: workers },
    gates: { wipCap: 99, verify: {}, noTouch: [] },
    models: { byComplexity: {}, default: undefined },
    tracker: {
      statuses: {
        backlog: "Backlog",
        ready: "Todo",
        inProgress: "In Progress",
        review: "In Review",
        needsApproval: "Needs Approval",
        done: "Done",
      },
      labels: { stuck: "crew:stuck", needsHuman: "crew:needs-human" },
    },
  } as unknown as CrewConfig;
}

const workItem = (n: number): WorkItem => ({
  id: `id-${n}`,
  identifier: `ABC-${n}`,
  title: `work ${n}`,
  description: "",
  type: "task",
  stateName: "Todo",
  priority: 3,
  parentId: null,
  parentApproved: null,
  url: "",
  assigneeId: null,
  labels: [],
});

/**
 * Ports over a fixed queue of items. Every item is handed out until the queue
 * is drained; `worked` records who actually got each one, which is where a
 * double-claim would show up.
 */
function queuePorts(items: WorkItem[]) {
  const worked: string[] = [];
  let concurrent = 0;
  let peak = 0;
  let cursor = 0;

  const ports = {
    meta: { myUserId: "U" },
    agents: {
      implementer: { name: "implementer", kind: "executor", prompt: "p", cadence: "c", builtin: true },
    },
    constitution: "c",
    tracker: {
      // Hands out each item once, so anything worked twice means the claim
      // failed rather than the queue re-offering it.
      selectNextExecutable: async () => items[cursor++] ?? null,
      countInProgress: async () => 0,
      countBacklog: async () => 0,
      transition: async () => {},
      assign: async () => {},
      addComment: async () => {},
      setLabels: async () => {},
      findSimilarOpen: async () => [],
      createIssue: async () => items[0],
    },
    git: {
      syncBase: async () => {},
      findWorktree: async () => null,
      createWorktree: async () => "/wt",
      hasCommits: async () => true,
      checkoutSnapshot: async () => ({ head: "h", dirty: [] }),
      strayWork: async () => ({ commits: [], dirtyFiles: [] }),
      noTouchViolations: async () => [],
      changedApps: async () => [],
      push: async () => {},
      openPr: async () => "https://pr/1",
      commentOnPr: async () => {},
      removeWorktree: async () => {},
      retainWorktree: async () => {},
    },
    persona: {
      run: async (_n: string, o: { prompt: string }) => {
        // Only count implement runs; reflection reuses this same port.
        if (/task you are implementing/i.test(o.prompt)) {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
        }
        return { summary: "done", raw: "" };
      },
    },
  } as unknown as Ports;

  return { ports, worked, peak: () => peak };
}

/** Run the loop until the queue drains, then stop it. */
async function drain(cfg: CrewConfig, ports: Ports, ms = 400): Promise<void> {
  resetStop();
  const done = runExecutorLoop(cfg, ports, silent);
  await new Promise((r) => setTimeout(r, ms));
  requestStop();
  await done;
}

test("backoffMs prefers a parsed reset time over the default", () => {
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const ms = backoffMs(soon, 30);
  assert.ok(ms > 4 * 60_000 && ms < 7 * 60_000, `got ${ms}`);
});

test("backoffMs falls back to the configured default", () => {
  assert.equal(backoffMs(null, 30), 30 * 60_000);
  assert.equal(backoffMs("not a date", 30), 30 * 60_000);
  // A reset already in the past must not produce a negative or zero wait.
  assert.equal(backoffMs(new Date(Date.now() - 60_000).toISOString(), 30), 30 * 60_000);
});

// ------------------------------ concurrency ---------------------------------

test("one worker works items one at a time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-loop-"));
  const { ports, peak } = queuePorts([workItem(1), workItem(2), workItem(3)]);
  await drain(cfgWith(1, dir), ports);
  assert.equal(peak(), 1, "a single worker must never overlap runs");
});

test("several workers implement concurrently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-loop-"));
  const items = Array.from({ length: 6 }, (_, i) => workItem(i + 1));
  const { ports, peak } = queuePorts(items);
  await drain(cfgWith(3, dir), ports);
  assert.ok(peak() > 1, `expected overlapping runs, peak was ${peak()}`);
});

test("no item is worked by two workers at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-loop-"));
  // Every selection returns the SAME item, which is exactly the race the claim
  // exists to arbitrate: without it, all workers would run it simultaneously.
  const only = workItem(1);
  let inFlight = 0;
  let peak = 0;
  const { ports } = queuePorts([]);
  (ports.tracker as unknown as Record<string, unknown>).selectNextExecutable = async () => only;
  (ports.persona as unknown as Record<string, unknown>).run = async (
    _n: string,
    o: { prompt: string },
  ) => {
    if (/task you are implementing/i.test(o.prompt)) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
    }
    return { summary: "done", raw: "" };
  };

  await drain(cfgWith(4, dir), ports);
  assert.equal(peak, 1, "the claim must serialize work on a single item");
});

// -------------------------------- idle --------------------------------------

test("the idle handler fires only once the whole team is dry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-loop-"));
  const calls: number[] = [];
  setIdleHandler((idleMs) => calls.push(idleMs));
  try {
    const { ports } = queuePorts([]); // nothing to do at all
    await drain(cfgWith(3, dir), ports, 150);
    assert.ok(calls.length > 0, "an empty board is still reported as idle");
  } finally {
    setIdleHandler(null);
  }
});

test("a busy board does not report the team as idle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-loop-"));
  let idled = false;
  setIdleHandler(() => {
    idled = true;
  });
  try {
    // Always work available, so no worker should ever go dry.
    const { ports } = queuePorts([]);
    (ports.tracker as unknown as Record<string, unknown>).selectNextExecutable = async () =>
      workItem(Math.floor(Math.random() * 1e6));
    await drain(cfgWith(2, dir), ports, 150);
    assert.equal(idled, false, "work was always available");
  } finally {
    setIdleHandler(null);
  }
});

test("wakeExecutor releases every sleeping worker, not just one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-loop-"));
  const cfg = cfgWith(3, dir);
  (cfg as unknown as { budget: { pollSeconds: number } }).budget.pollSeconds = 60;

  const { ports } = queuePorts([]); // all workers go idle and sleep
  resetStop();
  const done = runExecutorLoop(cfg, ports, silent);
  await new Promise((r) => setTimeout(r, 60));

  // With a 60s poll, only a working wake lets the loop stop promptly.
  const started = Date.now();
  requestStop();
  wakeExecutor();
  await done;
  assert.ok(Date.now() - started < 5_000, "all workers woke rather than waiting out the poll");
});
