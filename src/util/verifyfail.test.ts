import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearVerifyFailure,
  readVerifyFailure,
  writeVerifyFailure,
} from "./verifyfail.js";

/**
 * The presence of one of these records is what distinguishes a fix-forward
 * worktree (commit exists but verification rejected it) from a resume worktree
 * (commit exists and passed). The two are identical to git, so a wrong answer
 * here means pushing work the gate already refused.
 */

const fresh = () => mkdtempSync(join(tmpdir(), "crew-vf-"));

test("a written failure reads back verbatim", () => {
  const dir = fresh();
  writeVerifyFailure(dir, "ABC-1", "FAIL src/a.test.ts\n  expected 1, got 2");
  assert.equal(readVerifyFailure(dir, "ABC-1"), "FAIL src/a.test.ts\n  expected 1, got 2");
});

test("an item with no record reads as null", () => {
  assert.equal(readVerifyFailure(fresh(), "ABC-1"), null);
});

test("clearing removes the record", () => {
  const dir = fresh();
  writeVerifyFailure(dir, "ABC-1", "boom");
  clearVerifyFailure(dir, "ABC-1");
  assert.equal(readVerifyFailure(dir, "ABC-1"), null);
});

test("clearing an item that has no record is harmless", () => {
  clearVerifyFailure(fresh(), "ABC-404");
});

test("records are per-item and do not bleed across tickets", () => {
  const dir = fresh();
  writeVerifyFailure(dir, "ABC-1", "one");
  writeVerifyFailure(dir, "ABC-2", "two");
  assert.equal(readVerifyFailure(dir, "ABC-1"), "one");
  assert.equal(readVerifyFailure(dir, "ABC-2"), "two");
  clearVerifyFailure(dir, "ABC-1");
  assert.equal(readVerifyFailure(dir, "ABC-2"), "two", "clearing one must not clear the other");
});

test("a later write replaces the earlier failure", () => {
  const dir = fresh();
  writeVerifyFailure(dir, "ABC-1", "first failure");
  writeVerifyFailure(dir, "ABC-1", "second failure");
  assert.equal(readVerifyFailure(dir, "ABC-1"), "second failure");
});

test("empty output still records a readable marker", () => {
  // Otherwise an empty write would read back as null, silently turning a
  // fix-forward into a resume — which would push the rejected commit.
  const dir = fresh();
  writeVerifyFailure(dir, "ABC-1", "");
  assert.ok(readVerifyFailure(dir, "ABC-1"), "must still signal a pending fix");
});

test("an identifier with path separators cannot escape the directory", () => {
  const dir = fresh();
  writeVerifyFailure(dir, "../../etc/passwd", "boom");
  assert.equal(readVerifyFailure(dir, "../../etc/passwd"), "boom", "round-trips safely");
});

test("CREW_STATE_DIR redirects where records live", () => {
  const dir = fresh();
  const stateDir = fresh();
  process.env.CREW_STATE_DIR = stateDir;
  try {
    writeVerifyFailure(dir, "ABC-1", "boom");
    assert.equal(readVerifyFailure(dir, "ABC-1"), "boom");
  } finally {
    delete process.env.CREW_STATE_DIR;
  }
  // With the override gone, the record is not visible under configDir.
  assert.equal(readVerifyFailure(dir, "ABC-1"), null);
});
