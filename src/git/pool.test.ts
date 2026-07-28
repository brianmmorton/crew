import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSlot,
  findSlotForBranch,
  needsDeepClean,
  PoolExhaustedError,
  pidAlive,
  poolStatus,
  readMeta,
  releaseSlot,
  tryLock,
  unlock,
  untrackedToRemove,
  writeMeta,
} from "./pool.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "crew-pool-"));
}

const OPTS = { max: 2, preserveArtifacts: ["node_modules"], recycleAfter: 20 };

test("a slot is handed to exactly one caller", () => {
  const d = dir();
  const first = acquireSlot(d, OPTS, "agent/a");
  const second = acquireSlot(d, OPTS, "agent/b");
  assert.notEqual(first.slot, second.slot, "two acquires must never return the same slot");
});

test("concurrent workers in ONE process never share a slot", () => {
  // Workers run in a single supervisor process, so every claim here carries the
  // same pid. Treating "our own pid" as reclaimable handed one worktree to two
  // agents, which silently interleaved their commits.
  const d = dir();
  const opts = { ...OPTS, max: 4 };
  const claimed = [
    acquireSlot(d, opts, "agent/a"),
    acquireSlot(d, opts, "agent/b"),
    acquireSlot(d, opts, "agent/c"),
    acquireSlot(d, opts, "agent/d"),
  ].map((m) => m.slot);

  assert.equal(new Set(claimed).size, 4, "each concurrent acquire needs its own slot");
  assert.throws(() => acquireSlot(d, opts, "agent/e"), PoolExhaustedError);
});

test("acquiring past max throws rather than overflowing", () => {
  const d = dir();
  acquireSlot(d, OPTS, "agent/a");
  acquireSlot(d, OPTS, "agent/b");
  // Overflowing would make worktrees.max meaningless, and each extra slot is a
  // full checkout of a repo big enough to need pooling in the first place.
  assert.throws(() => acquireSlot(d, OPTS, "agent/c"), PoolExhaustedError);
});

test("the lock is exclusive while held and reclaimable once the owner is gone", () => {
  const d = dir();
  assert.equal(tryLock(d, 0), true);

  // A live owner keeps the lock: simulate one by writing a pid that exists.
  writeFileSync(join(d, "slot-0.lock"), `${process.ppid}\n`);
  assert.equal(tryLock(d, 0), false, "a live owner's lock must not be stolen");

  // A dead owner's lock is stale and must be reclaimable, or a crashed run
  // would leak that slot forever.
  writeFileSync(join(d, "slot-0.lock"), "999999999\n");
  assert.equal(tryLock(d, 0), true, "a dead owner's lock must be reclaimable");
});

test("a retained slot is never handed out, even if its owner died", () => {
  const d = dir();
  const meta = acquireSlot(d, OPTS, "agent/a");
  releaseSlot(d, meta.slot, true); // retained: holds an unlanded verified commit

  const other = acquireSlot(d, OPTS, "agent/b");
  assert.notEqual(other.slot, meta.slot, "retained work must not be recycled");

  // With the only other slot busy, the pool is exhausted rather than
  // sacrificing the retained one.
  assert.throws(() => acquireSlot(d, OPTS, "agent/c"), PoolExhaustedError);
});

test("a retained slot is findable by branch so resume can reach its commit", () => {
  const d = dir();
  const meta = acquireSlot(d, OPTS, "agent/abc-1");
  releaseSlot(d, meta.slot, true);

  const found = findSlotForBranch(d, OPTS.max, "agent/abc-1");
  assert.equal(found?.slot, meta.slot, "resume must find the verified commit, not redo it");
});

test("releasing without retention returns the slot to the pool", () => {
  const d = dir();
  const meta = acquireSlot(d, OPTS, "agent/a");
  releaseSlot(d, meta.slot, false);
  assert.equal(readMeta(d, meta.slot).state, "free");
  assert.equal(readMeta(d, meta.slot).branch, null);

  const again = acquireSlot(d, OPTS, "agent/b");
  assert.equal(again.slot, meta.slot, "a freed slot is reused");
});

test("the exhaustion error separates busy from retained", () => {
  const d = dir();
  const a = acquireSlot(d, OPTS, "agent/a");
  releaseSlot(d, a.slot, true);
  const b = acquireSlot(d, OPTS, "agent/b");
  releaseSlot(d, b.slot, true);

  // Both retained: waiting would never help, and the caller needs to know that
  // rather than blocking for the full timeout.
  try {
    acquireSlot(d, OPTS, "agent/c");
    assert.fail("expected exhaustion");
  } catch (e) {
    assert.ok(e instanceof PoolExhaustedError);
    assert.equal(e.retained, 2);
    assert.equal(e.busy, 0);
  }
});

test("preserved artifacts survive a reset; everything else untracked does not", () => {
  const porcelain = [
    "?? node_modules/",
    "?? packages/web/node_modules/",
    "?? scratch.txt",
    "?? packages/web/src/leftover.ts",
    " M src/tracked.ts",
  ].join("\n");

  const remove = untrackedToRemove(porcelain, ["node_modules"]);
  assert.deepEqual(remove, ["scratch.txt", "packages/web/src/leftover.ts"]);
});

test("preserved artifacts are matched at any depth, not just the root", () => {
  // A monorepo's caches live under packages/*/, so root-only matching would
  // delete exactly the artifacts pooling exists to keep.
  const remove = untrackedToRemove("?? apps/api/node_modules/\n", ["node_modules"]);
  assert.deepEqual(remove, []);
});

test("modified tracked files are left to reset --hard, not deleted by path", () => {
  const remove = untrackedToRemove(" M src/a.ts\nA  src/b.ts\n", ["node_modules"]);
  assert.deepEqual(remove, [], "only ?? entries are untracked leftovers");
});

test("quoted paths with spaces are unescaped before deletion", () => {
  const remove = untrackedToRemove('?? "some dir/a b.txt"\n', []);
  assert.deepEqual(remove, ["some dir/a b.txt"]);
});

test("a deep clean fires at recycleAfter and can be disabled", () => {
  // useCount is "resets since the last deep clean", counted inclusive of the
  // reset being decided — so recycleAfter:1 cleans on the first reuse.
  const base = { ...readMeta(dir(), 0) };
  assert.equal(needsDeepClean({ ...base, useCount: 19 }, 20), false);
  assert.equal(needsDeepClean({ ...base, useCount: 20 }, 20), true);
  assert.equal(needsDeepClean({ ...base, useCount: 1 }, 1), true);
  // 0 means "never deep clean" — residue accumulates by explicit choice.
  assert.equal(needsDeepClean({ ...base, useCount: 999 }, 0), false);
});

test("corrupt slot metadata reads as an unused slot rather than throwing", () => {
  const d = dir();
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "slot-0.json"), "{not json");
  const meta = readMeta(d, 0);
  assert.equal(meta.state, "free");
  assert.equal(meta.useCount, 0);
});

test("pidAlive rejects a pid that cannot exist", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(999999999), false);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
});

test("poolStatus reports every slot for diagnostics", () => {
  const d = dir();
  const a = acquireSlot(d, OPTS, "agent/a");
  releaseSlot(d, a.slot, true);
  const status = poolStatus(d, 2);
  assert.equal(status.length, 2);
  assert.equal(status.filter((s) => s.state === "retained").length, 1);
  assert.equal(status.filter((s) => s.state === "free").length, 1);
});

test("unlock lets another caller take the slot", () => {
  const d = dir();
  assert.equal(tryLock(d, 0), true);
  writeFileSync(join(d, "slot-0.lock"), `${process.ppid}\n`);
  assert.equal(tryLock(d, 0), false);
  unlock(d, 0);
  assert.equal(tryLock(d, 0), true);
});

test("writeMeta round-trips through readMeta", () => {
  const d = dir();
  writeMeta(d, {
    slot: 1,
    state: "busy",
    branch: "agent/x",
    pid: 42,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    useCount: 3,
    lastDeepClean: null,
  });
  const meta = readMeta(d, 1);
  assert.equal(meta.branch, "agent/x");
  assert.equal(meta.useCount, 3);
  assert.equal(JSON.parse(readFileSync(join(d, "slot-1.json"), "utf8")).pid, 42);
});
