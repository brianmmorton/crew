import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignKeys,
  buildLegend,
  keyToAction,
  scheduleInterval,
  dueOnStartup,
} from "./supervisor.js";

test("keyToAction maps the fixed control keys", () => {
  assert.equal(keyToAction("i", false), "impl");
  assert.equal(keyToAction("p", false), "pause");
  assert.equal(keyToAction("s", false), "status");
  assert.equal(keyToAction("k", false), "kill");
  assert.equal(keyToAction("c", true), "quit");
  assert.equal(keyToAction("x", false), null);
  assert.equal(keyToAction(undefined, false), null);
});

test("keyToAction runs the agent bound to a key", () => {
  const keys = assignKeys(["qa", "design", "architect"]);
  assert.deepEqual(keyToAction("q", false, keys), { run: "qa" });
  assert.deepEqual(keyToAction("d", false, keys), { run: "design" });
  assert.deepEqual(keyToAction("a", false, keys), { run: "architect" });
  assert.equal(keyToAction("z", false, keys), null);
});

test("assignKeys gives the built-ins their historical keys", () => {
  const keys = assignKeys(["architect", "design", "qa"]);
  assert.equal(keys.get("a"), "architect");
  assert.equal(keys.get("d"), "design");
  assert.equal(keys.get("q"), "qa");
});

test("assignKeys never collides with a reserved control key", () => {
  // "security" would want "s" (status) and "kill-switch" would want "k".
  const keys = assignKeys(["security", "kill-switch"]);
  assert.equal(keys.get("s"), undefined);
  assert.equal(keys.get("k"), undefined);
  assert.equal(keys.get("e"), "security"); // s taken → next free letter
  assert.equal(keys.get("l"), "kill-switch"); // k,i taken → l
});

test("assignKeys resolves collisions between agents in order", () => {
  const keys = assignKeys(["docs", "design"]);
  assert.equal(keys.get("d"), "docs");
  assert.equal(keys.get("e"), "design");
});

test("assignKeys falls back to digits when no letter is free", () => {
  // Every letter of "aeon" is consumed by earlier agents in this set.
  const keys = assignKeys(["a", "e", "o", "n", "aeon"]);
  assert.equal(keys.get("1"), "aeon");
});

test("buildLegend lists agent keys before the fixed controls", () => {
  const legend = buildLegend(assignKeys(["qa", "design"]));
  assert.match(legend, /\[q\]qa/);
  assert.match(legend, /\[d\]design/);
  assert.match(legend, /\[i\]impl-now/);
  assert.ok(legend.indexOf("[q]qa") < legend.indexOf("[i]impl-now"));
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
