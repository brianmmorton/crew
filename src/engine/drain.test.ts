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
