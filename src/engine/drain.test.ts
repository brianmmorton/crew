import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_ITERATIONS,
  decideDrainStep,
  maxUnproductive,
  runDoneWhen,
  type DrainLimits,
  type DrainTickInput,
} from "./drain.js";

const limits = (extra: Partial<DrainLimits> = {}): DrainLimits => ({
  maxInProgress: 2,
  maxIterations: 5,
  maxUnproductive: 2,
  ...extra,
});

const tick = (extra: Partial<DrainTickInput> = {}): DrainTickInput => ({
  done: false,
  inProgress: 0,
  iterations: 0,
  unproductive: 0,
  ...extra,
});

// ----------------------------- decideDrainStep -----------------------------

test("a fresh tick with room proposes", () => {
  assert.deepEqual(decideDrainStep(tick(), limits()), { step: "propose" });
});

test("a passing doneWhen completes the session", () => {
  assert.deepEqual(decideDrainStep(tick({ done: true }), limits()), { step: "complete" });
});

test("completion wins even at every cap at once", () => {
  // The goal being met is never a failure — caps must not mask it.
  const input = tick({ done: true, inProgress: 9, iterations: 9, unproductive: 9 });
  assert.deepEqual(decideDrainStep(input, limits()), { step: "complete" });
});

test("no doneWhen (null) never reads as complete", () => {
  assert.deepEqual(decideDrainStep(tick({ done: null }), limits()), { step: "propose" });
});

test("the in-progress cap waits instead of proposing", () => {
  assert.deepEqual(decideDrainStep(tick({ inProgress: 2 }), limits()), { step: "wait" });
  assert.deepEqual(decideDrainStep(tick({ inProgress: 1 }), limits()), { step: "propose" });
});

test("the iteration cap stops the session", () => {
  assert.deepEqual(decideDrainStep(tick({ iterations: 5 }), limits()), {
    step: "stop",
    reason: "iteration-cap",
  });
});

test("consecutive empty iterations stop the session", () => {
  assert.deepEqual(decideDrainStep(tick({ unproductive: 2 }), limits()), {
    step: "stop",
    reason: "no-progress",
  });
  assert.deepEqual(decideDrainStep(tick({ unproductive: 1 }), limits()), { step: "propose" });
});

test("stops take precedence over the wait — a full board can't mask a dead session", () => {
  // Otherwise a session that will never file again idles forever behind
  // someone else's in-progress work instead of reporting itself finished.
  const input = tick({ inProgress: 9, unproductive: 2 });
  assert.deepEqual(decideDrainStep(input, limits()), { step: "stop", reason: "no-progress" });
});

test("maxUnproductive allows one retry only when a doneWhen is the authority", () => {
  assert.equal(maxUnproductive(true), 2);
  assert.equal(maxUnproductive(false), 1);
});

test("the default iteration cap is a real bound", () => {
  assert.ok(DEFAULT_MAX_ITERATIONS >= 1);
  assert.deepEqual(
    decideDrainStep(
      tick({ iterations: DEFAULT_MAX_ITERATIONS }),
      limits({ maxIterations: DEFAULT_MAX_ITERATIONS }),
    ),
    { step: "stop", reason: "iteration-cap" },
  );
});

// ------------------------------- runDoneWhen -------------------------------

test("runDoneWhen: exit 0 is done, with stdout kept as the report", async () => {
  const r = await runDoneWhen("echo all clear", process.cwd());
  assert.equal(r.done, true);
  assert.equal(r.output, "all clear");
});

test("runDoneWhen: a non-zero exit is not done", async () => {
  const r = await runDoneWhen("echo 3 files remain; exit 1", process.cwd());
  assert.equal(r.done, false);
  assert.equal(r.output, "3 files remain");
});

test("runDoneWhen: a command that cannot run reads as not-done, carrying the error", async () => {
  const r = await runDoneWhen("definitely-not-a-real-binary-xyz", process.cwd());
  assert.equal(r.done, false);
  assert.ok(r.output.length > 0); // the shell's error message, for the log
});

// ------------------------------ drainContext --------------------------------

import { DEFAULT_DRAIN_MAX_PROPOSALS, drainContext } from "./drain.js";
import type { AgentDef, WorkItem } from "../types.js";

const def = {
  name: "migrator",
  kind: "proposer",
  prompt: "",
  cadence: "",
  builtin: false,
  mode: "drain",
  doneWhen: "check-cmd",
} as AgentDef;

const open = (identifier: string, title: string, stateName: string): WorkItem =>
  ({ identifier, title, stateName }) as WorkItem;

test("drain iterations default to one proposal — pace is set by review, not the agent", () => {
  assert.equal(DEFAULT_DRAIN_MAX_PROPOSALS, 1);
});

test("drainContext shows the board's open issues so proposals steer around them", () => {
  const ctx = drainContext(def, undefined, [], [open("IT-1", "migrate app.ts", "In Progress")], 1);
  assert.match(ctx, /IT-1 \[In Progress\] migrate app\.ts/);
  assert.match(ctx, /do NOT propose work these already cover/);
});

test("drainContext tells the agent it files work rather than doing it", () => {
  const ctx = drainContext(def, undefined, [], [], 1);
  assert.match(ctx, /DO NOT do the work/);
  assert.match(ctx, /never edit, commit/);
  assert.match(ctx, /at most 1 item/);
  assert.match(ctx, /ONE\s+reviewable pull request/);
});

test("drainContext carries the completion check output and the session's filed items", () => {
  const ctx = drainContext(def, "a.ts\nb.ts", ["IT-7"], [], 2);
  assert.match(ctx, /check-cmd/);
  assert.match(ctx, /a\.ts\nb\.ts/);
  assert.match(ctx, /Already filed this session .*: IT-7/);
  assert.match(ctx, /at most 2 item/);
});

test("drainContext omits the sections it has nothing for", () => {
  const ctx = drainContext(def, undefined, [], [], 1);
  assert.ok(!/Open issues on the board/.test(ctx));
  assert.ok(!/completion check/.test(ctx));
  assert.ok(!/Already filed/.test(ctx));
});
