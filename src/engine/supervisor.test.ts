import { test } from "node:test";
import assert from "node:assert/strict";
import { keyToAction, scheduleInterval, dueOnStartup } from "./supervisor.js";

test("keyToAction maps persona + control keys", () => {
  assert.equal(keyToAction("q", false), "qa");
  assert.equal(keyToAction("d", false), "design");
  assert.equal(keyToAction("a", false), "architect");
  assert.equal(keyToAction("i", false), "impl");
  assert.equal(keyToAction("p", false), "pause");
  assert.equal(keyToAction("s", false), "status");
  assert.equal(keyToAction("c", true), "quit");
  assert.equal(keyToAction("x", false), null);
  assert.equal(keyToAction(undefined, false), null);
});

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
