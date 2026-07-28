import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { CrewConfig } from "../types.js";
import { acquireClaim, claimDir } from "./claim.js";
import { writeVerifyFailure } from "../util/verifyfail.js";
import { setResumeAttempts, setVerifyAttempts } from "../util/state.js";
import { formatStuck, stuckItems } from "./stuck.js";

/**
 * These states were previously findable only by reading scrollback: a claim
 * nobody will release, and a worktree held out of the pool. This is what
 * `crew status` / `crew worktrees` render, so it has to name the item AND say
 * which of those situations it is in.
 */

const fresh = () => mkdtempSync(join(tmpdir(), "crew-stuck-"));
const cfgFor = (configDir: string) => ({ configDir }) as unknown as CrewConfig;

/** A pid guaranteed not to be running, so the claim reads as abandoned. */
const DEAD_PID = 2 ** 22;

function plantDeadClaim(dir: string, id: string): void {
  mkdirSync(claimDir(dir), { recursive: true });
  writeFileSync(
    join(claimDir(dir), `${id}.json`),
    JSON.stringify({ identifier: id, pid: DEAD_PID, host: hostname(), acquiredAt: "2020-01-01T00:00:00.000Z" }),
  );
}

test("nothing in flight reports nothing", () => {
  assert.deepEqual(stuckItems(cfgFor(fresh())), []);
});

test("a live claim with no pending fix is reported as working", () => {
  const dir = fresh();
  acquireClaim(dir, "ABC-1");
  const [item] = stuckItems(cfgFor(dir));
  assert.equal(item.state, "working");
  assert.equal(item.identifier, "ABC-1");
});

test("a live claim with a pending verify failure is reported as fixing", () => {
  const dir = fresh();
  acquireClaim(dir, "ABC-1");
  writeVerifyFailure(dir, "ABC-1", "FAIL a.test.ts\n  expected 1, got 2");
  const [item] = stuckItems(cfgFor(dir));
  assert.equal(item.state, "fixing");
  assert.equal(item.reason, "FAIL a.test.ts", "the first line hints at what broke");
});

test("a claim whose owner is gone is reported as abandoned", () => {
  const dir = fresh();
  plantDeadClaim(dir, "ABC-1");
  const [item] = stuckItems(cfgFor(dir));
  assert.equal(item.state, "abandoned");
});

test("abandoned wins over fixing — the dead worker is the urgent part", () => {
  const dir = fresh();
  plantDeadClaim(dir, "ABC-1");
  writeVerifyFailure(dir, "ABC-1", "boom");
  assert.equal(stuckItems(cfgFor(dir))[0].state, "abandoned");
});

test("attempt counters are carried through", () => {
  const dir = fresh();
  acquireClaim(dir, "ABC-1");
  setVerifyAttempts(dir, "ABC-1", 1);
  setResumeAttempts(dir, "ABC-1", 2);
  const [item] = stuckItems(cfgFor(dir));
  assert.equal(item.verifyTries, 1);
  assert.equal(item.landTries, 2);
});

test("items sort abandoned first, then fixing, then working", () => {
  const dir = fresh();
  acquireClaim(dir, "LIVE-1");
  acquireClaim(dir, "FIX-1");
  writeVerifyFailure(dir, "FIX-1", "boom");
  plantDeadClaim(dir, "DEAD-1");

  assert.deepEqual(
    stuckItems(cfgFor(dir)).map((i) => i.identifier),
    ["DEAD-1", "FIX-1", "LIVE-1"],
  );
});

test("a verify record with no claim is not reported", () => {
  // An item waiting to be picked up again is working as intended, not stuck.
  const dir = fresh();
  writeVerifyFailure(dir, "ABC-1", "boom");
  assert.deepEqual(stuckItems(cfgFor(dir)), []);
});

// -------------------------------- rendering ---------------------------------

test("each rendered line names the item and its state", () => {
  const dir = fresh();
  acquireClaim(dir, "ABC-1");
  const [line] = formatStuck(stuckItems(cfgFor(dir)));
  assert.match(line, /ABC-1/);
  assert.match(line, /working/);
});

test("a rendered line shows attempt counts when there are any", () => {
  const dir = fresh();
  acquireClaim(dir, "ABC-1");
  setVerifyAttempts(dir, "ABC-1", 1);
  const [line] = formatStuck(stuckItems(cfgFor(dir)));
  assert.match(line, /verify 1/);
});

test("a rendered line omits the counts when there are none", () => {
  const dir = fresh();
  acquireClaim(dir, "ABC-1");
  const [line] = formatStuck(stuckItems(cfgFor(dir)));
  assert.ok(!/verify|land/.test(line), line);
});

test("a long failure line is truncated so it fits one row", () => {
  const dir = fresh();
  acquireClaim(dir, "ABC-1");
  writeVerifyFailure(dir, "ABC-1", "x".repeat(500));
  const [item] = stuckItems(cfgFor(dir));
  assert.ok((item.reason ?? "").length <= 100, "reason stays short");
  assert.match(item.reason ?? "", /…$/);
});

test("a failure whose first lines are blank still yields a reason", () => {
  const dir = fresh();
  acquireClaim(dir, "ABC-1");
  writeVerifyFailure(dir, "ABC-1", "\n\n   \nreal failure here");
  assert.equal(stuckItems(cfgFor(dir))[0].reason, "real failure here");
});
