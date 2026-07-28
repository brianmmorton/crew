import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireClaim,
  claimDir,
  listClaims,
  pidAlive,
  releaseClaim,
  staleClaims,
} from "./claim.js";

/**
 * These cover the arbitration `selectNextExecutable()` cannot do: the tracker
 * has no compare-and-set, so two workers can be handed the same item. Exactly
 * one of them must end up working it.
 */

const fresh = () => mkdtempSync(join(tmpdir(), "crew-claim-"));

/** Write a claim file directly, to simulate another worker's lock. */
function plantClaim(dir: string, id: string, claim: Record<string, unknown>): void {
  mkdirSync(claimDir(dir), { recursive: true });
  writeFileSync(join(claimDir(dir), `${id}.json`), JSON.stringify(claim));
}

// ------------------------------ basics --------------------------------------

test("an unclaimed ticket can be claimed", () => {
  const dir = fresh();
  assert.equal(acquireClaim(dir, "ABC-1"), true);
});

test("releasing lets the ticket be claimed again", () => {
  const dir = fresh();
  acquireClaim(dir, "ABC-1");
  releaseClaim(dir, "ABC-1");
  assert.equal(acquireClaim(dir, "ABC-1"), true);
});

test("releasing a ticket that was never claimed is harmless", () => {
  const dir = fresh();
  releaseClaim(dir, "ABC-404");
});

test("different tickets never contend", () => {
  const dir = fresh();
  assert.equal(acquireClaim(dir, "ABC-1"), true);
  assert.equal(acquireClaim(dir, "ABC-2"), true);
});

// ------------------------------ the race ------------------------------------

/**
 * The bug this prevents: two workers both select ABC-1, both transition it, and
 * both run an agent against the same branch. The second claim must lose even
 * though it comes from THIS pid — workers share one supervisor process, so a
 * same-pid shortcut would let siblings collide.
 */
test("a live holder's claim cannot be taken, even by the same pid", () => {
  const dir = fresh();
  assert.equal(acquireClaim(dir, "ABC-1"), true);
  assert.equal(acquireClaim(dir, "ABC-1"), false, "a sibling worker must lose the race");
});

test("the winner's identity is what lands on disk", () => {
  const dir = fresh();
  acquireClaim(dir, "ABC-1");
  const claims = listClaims(dir);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].identifier, "ABC-1");
  assert.equal(claims[0].pid, process.pid);
});

// ------------------------- crashed-owner recovery ---------------------------

/**
 * A worker that dies mid-run leaves its claim behind. Nothing else will ever
 * release it, so a claim whose owner is gone must be reclaimable — otherwise
 * the ticket is stranded permanently.
 */

/** A pid that is guaranteed not to be running. */
const DEAD_PID = 2 ** 22;

test("a dead owner's claim is reclaimed", () => {
  const dir = fresh();
  plantClaim(dir, "ABC-1", {
    identifier: "ABC-1",
    pid: DEAD_PID,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
  });
  assert.equal(acquireClaim(dir, "ABC-1"), true, "stranded work must be recoverable");
});

test("reclaiming overwrites the dead owner's record", () => {
  const dir = fresh();
  plantClaim(dir, "ABC-1", {
    identifier: "ABC-1",
    pid: DEAD_PID,
    host: hostname(),
    acquiredAt: "2020-01-01T00:00:00.000Z",
  });
  acquireClaim(dir, "ABC-1");
  assert.equal(listClaims(dir)[0].pid, process.pid);
});

test("staleClaims surfaces stranded work and ignores live claims", () => {
  const dir = fresh();
  acquireClaim(dir, "LIVE-1");
  plantClaim(dir, "DEAD-1", {
    identifier: "DEAD-1",
    pid: DEAD_PID,
    host: hostname(),
    acquiredAt: "2020-01-01T00:00:00.000Z",
  });
  assert.deepEqual(
    staleClaims(dir).map((c) => c.identifier),
    ["DEAD-1"],
  );
});

// ------------------------------ foreign hosts -------------------------------

/**
 * A pid from another machine says nothing about liveness here — the number may
 * coincidentally match a local process. Stealing on that basis would hand one
 * ticket to two machines, so foreign claims are always treated as held.
 */
test("a claim from another host is never stolen, even with a dead-looking pid", () => {
  const dir = fresh();
  plantClaim(dir, "ABC-1", {
    identifier: "ABC-1",
    pid: DEAD_PID,
    host: "some-other-machine",
    acquiredAt: new Date().toISOString(),
  });
  assert.equal(acquireClaim(dir, "ABC-1"), false);
});

test("a foreign claim is not reported as stale", () => {
  const dir = fresh();
  plantClaim(dir, "ABC-1", {
    identifier: "ABC-1",
    pid: DEAD_PID,
    host: "some-other-machine",
    acquiredAt: new Date().toISOString(),
  });
  assert.deepEqual(staleClaims(dir), []);
});

// ------------------------------ robustness ----------------------------------

test("a corrupt claim file does not strand the ticket", () => {
  const dir = fresh();
  mkdirSync(claimDir(dir), { recursive: true });
  writeFileSync(join(claimDir(dir), "ABC-1.json"), "{ not json");
  assert.equal(acquireClaim(dir, "ABC-1"), true, "no readable owner to protect");
});

test("listClaims ignores unreadable files rather than throwing", () => {
  const dir = fresh();
  mkdirSync(claimDir(dir), { recursive: true });
  writeFileSync(join(claimDir(dir), "ABC-1.json"), "{ not json");
  assert.deepEqual(listClaims(dir), []);
});

test("listClaims on a directory that was never created is empty", () => {
  assert.deepEqual(listClaims(fresh()), []);
});

test("an identifier with path separators cannot escape the claims directory", () => {
  const dir = fresh();
  assert.equal(acquireClaim(dir, "../../etc/passwd"), true);
  // The claim landed inside the claims dir under a flattened name.
  const claims = listClaims(dir);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].identifier, "../../etc/passwd", "original id is preserved in the record");
});

test("pidAlive says yes for this process and no for a dead pid", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(DEAD_PID), false);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
});

// --------------------------- state dir override -----------------------------

test("CREW_STATE_DIR redirects where claims live", () => {
  const dir = fresh();
  const stateDir = fresh();
  process.env.CREW_STATE_DIR = stateDir;
  try {
    acquireClaim(dir, "ABC-1");
    assert.equal(listClaims(dir).length, 1, "read back through the same override");
    assert.ok(
      readFileSync(join(claimDir(dir), "ABC-1.json"), "utf8").includes("ABC-1"),
      "claim file is under the override, not configDir",
    );
  } finally {
    delete process.env.CREW_STATE_DIR;
  }
});
