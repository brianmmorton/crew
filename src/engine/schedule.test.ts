import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideIdleRun,
  dueOnStartup,
  scheduleInterval,
  shouldRunProposer,
} from "./schedule.js";

test("scheduleInterval ~ 6h for '0 */6 * * *'", () => {
  const ms = scheduleInterval("0 */6 * * *");
  assert.equal(ms, 6 * 60 * 60 * 1000);
});

test("scheduleInterval Infinity for garbage", () => {
  assert.equal(scheduleInterval("not a cron"), Infinity);
});

test("dueOnStartup: never-run is due", () => {
  assert.equal(dueOnStartup("0 */6 * * *", undefined), true);
});

test("dueOnStartup: just-ran is not due", () => {
  const now = 1_800_000_000_000;
  const justNow = new Date(now - 60_000).toISOString();
  assert.equal(dueOnStartup("0 */6 * * *", justNow, now), false);
});

test("dueOnStartup: a full interval ago is due", () => {
  const now = 1_800_000_000_000;
  const old = new Date(now - 7 * 60 * 60 * 1000).toISOString(); // >6h
  assert.equal(dueOnStartup("0 */6 * * *", old, now), true);
});

// --------------------------- the run throttle ------------------------------

const runInput = (over: Partial<Parameters<typeof shouldRunProposer>[0]> = {}) => ({
  running: false,
  paused: false,
  manual: false,
  sinceLastRun: Infinity,
  minIntervalMinutes: 30,
  ...over,
});

test("shouldRunProposer: a never-run agent on an idle pool fires", () => {
  assert.deepEqual(shouldRunProposer(runInput()), { run: true });
});

test("shouldRunProposer: a recent run throttles the next one", () => {
  const d = shouldRunProposer(runInput({ sinceLastRun: 5 * 60_000 }));
  assert.deepEqual(d, { run: false, reason: "throttled" });
});

test("shouldRunProposer: past minInterval it fires again", () => {
  assert.deepEqual(shouldRunProposer(runInput({ sinceLastRun: 31 * 60_000 })), {
    run: true,
  });
});

test("shouldRunProposer: a paused pool holds scheduled runs", () => {
  assert.deepEqual(shouldRunProposer(runInput({ paused: true })), {
    run: false,
    reason: "paused",
  });
});

test("shouldRunProposer: manual overrides both the throttle and the pause", () => {
  const d = shouldRunProposer(
    runInput({ manual: true, paused: true, sinceLastRun: 1000 }),
  );
  assert.deepEqual(d, { run: true });
});

test("shouldRunProposer: never doubles up a live run, even manually", () => {
  const d = shouldRunProposer(runInput({ running: true, manual: true }));
  assert.deepEqual(d, { run: false, reason: "running" });
});

// --------------------------- idle triggers ---------------------------------

const IDLE_CFG = { afterMinutes: 10, maxBacklog: 0, maxEmptyRuns: 3 };
const idleInput = (over: Partial<Parameters<typeof decideIdleRun>[0]> = {}) => ({
  idleMs: 30 * 60_000,
  backlog: 0,
  emptyRuns: 0,
  gaveUpAtBacklog: null,
  paused: false,
  running: false,
  ...over,
});

test("decideIdleRun: fires once idle past the threshold with an empty board", () => {
  assert.deepEqual(decideIdleRun(idleInput(), IDLE_CFG), {
    run: true,
    clearedLatch: false,
  });
});

test("decideIdleRun: waits out afterMinutes", () => {
  const d = decideIdleRun(idleInput({ idleMs: 5 * 60_000 }), IDLE_CFG);
  assert.equal(d.run, false);
});

test("decideIdleRun: a backlog means promote, not propose", () => {
  const d = decideIdleRun(idleInput({ backlog: 4 }), IDLE_CFG);
  assert.equal(d.run, false);
});

test("decideIdleRun: paused and in-flight runs are never doubled up", () => {
  assert.equal(decideIdleRun(idleInput({ paused: true }), IDLE_CFG).run, false);
  assert.equal(decideIdleRun(idleInput({ running: true }), IDLE_CFG).run, false);
});

test("decideIdleRun: gives up after maxEmptyRuns empty runs", () => {
  const d = decideIdleRun(
    idleInput({ emptyRuns: 3, gaveUpAtBacklog: 0 }),
    IDLE_CFG,
  );
  assert.equal(d.run, false);
});

test("decideIdleRun: a changed backlog clears the give-up latch", () => {
  // Gave up with an empty backlog; a human has since filed something.
  const d = decideIdleRun(
    idleInput({ emptyRuns: 3, gaveUpAtBacklog: 0, backlog: 0 }),
    { ...IDLE_CFG, maxBacklog: 2 },
  );
  assert.deepEqual(d, { run: false, reason: "gave up; board unchanged" });

  const moved = decideIdleRun(
    idleInput({ emptyRuns: 3, gaveUpAtBacklog: 0, backlog: 1 }),
    { ...IDLE_CFG, maxBacklog: 2 },
  );
  assert.deepEqual(moved, { run: true, clearedLatch: true });
});
