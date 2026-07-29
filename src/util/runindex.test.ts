import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  amendRun,
  appendRunIndex,
  pruneRunLogs,
  recordRun,
  runIndexPath,
  trimReason,
  type RunRecord,
} from "./runlog.js";
import { highlights, readRunIndex, readSessions, toSessions } from "./runindex.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crew-runindex-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "x.log",
    kind: "implement",
    at: "2026-07-28T10:00:00.000Z",
    ...over,
  };
}

// ----------------------------- writer --------------------------------------

test("recordRun writes the log file and a matching index line", () => {
  const path = recordRun(dir, "implementer-ENG-1", "hello output", {
    kind: "implement",
    agent: "implementer",
    item: "ENG-1",
    title: "Fix the thing",
    outcome: "ok",
    ms: 1234,
  });

  assert.ok(path, "expected a log path");
  const records = readRunIndex(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.item, "ENG-1");
  assert.equal(records[0]!.outcome, "ok");
  assert.equal(records[0]!.ms, 1234);
  // The index joins back to the raw output by basename.
  assert.equal(records[0]!.id, path!.split("/").pop());
  assert.equal(records[0]!.logPath, path);
});

test("index survives a torn line rather than losing all history", () => {
  appendRunIndex(dir, rec({ item: "ENG-1" }));
  writeFileSync(runIndexPath(dir), '{"id":"broken","at":\n', { flag: "a" });
  appendRunIndex(dir, rec({ item: "ENG-2" }));

  const records = readRunIndex(dir);
  assert.deepEqual(
    records.map((r) => r.item),
    ["ENG-1", "ENG-2"],
  );
});

test("reads are bounded to the tail and never emit a partial record", () => {
  for (let i = 0; i < 200; i++) appendRunIndex(dir, rec({ item: `ENG-${i}`, id: `${i}.log` }));
  // A tiny budget forces a mid-record start; the partial head must be dropped.
  const records = readRunIndex(dir, 2_000);
  assert.ok(records.length > 0 && records.length < 200, "expected a bounded slice");
  for (const r of records) assert.match(r.item!, /^ENG-\d+$/);
  // Whatever survived must be the NEWEST records, not the oldest.
  assert.equal(records.at(-1)!.item, "ENG-199");
});

test("a missing index reads as empty, not a throw", () => {
  assert.deepEqual(readRunIndex(join(dir, "nope")), []);
  assert.deepEqual(readSessions(join(dir, "nope")), []);
});

// ----------------------------- grouping ------------------------------------

test("sessions group by item, newest first, worst outcome wins", () => {
  const sessions = toSessions([
    rec({ item: "ENG-1", at: "2026-07-28T10:00:00Z", agent: "implementer", kind: "implement" }),
    rec({ item: "ENG-1", at: "2026-07-28T10:05:00Z", agent: "implementer", kind: "verify", outcome: "failed" }),
    rec({ item: "ENG-1", at: "2026-07-28T10:09:00Z", agent: "implementer", kind: "verify", outcome: "ok" }),
    rec({ item: "ENG-2", at: "2026-07-28T11:00:00Z", agent: "qa", outcome: "ok" }),
  ]);

  assert.equal(sessions.length, 2);
  // ENG-2 is newer, so it sorts first.
  assert.equal(sessions[0]!.key, "ENG-2");
  const eng1 = sessions[1]!;
  assert.equal(eng1.runs.length, 3);
  // A failure anywhere in the session must still read as trouble.
  assert.equal(eng1.outcome, "failed");
});

test("sessions accumulate agents, pr url and duration across runs", () => {
  const [s] = toSessions([
    rec({ item: "ENG-9", agent: "implementer", ms: 1000, at: "2026-07-28T10:00:00Z" }),
    rec({ item: "ENG-9", agent: "reviewer", ms: 500, kind: "review", prUrl: "https://pr/9", at: "2026-07-28T10:01:00Z" }),
    rec({ item: "ENG-9", agent: "reviewer", ms: 500, kind: "review", at: "2026-07-28T10:02:00Z" }),
  ]);

  assert.deepEqual(s!.agents, ["implementer", "reviewer"]);
  assert.equal(s!.prUrl, "https://pr/9");
  assert.equal(s!.ms, 2000);
});

test("runs without an item stay separate sessions instead of collapsing by agent", () => {
  const sessions = toSessions([
    rec({ id: "a.log", kind: "propose", agent: "qa", at: "2026-07-28T10:00:00Z" }),
    rec({ id: "b.log", kind: "propose", agent: "qa", at: "2026-07-28T11:00:00Z" }),
  ]);
  assert.equal(sessions.length, 2, "two proposals by one agent are two sessions");
  assert.equal(sessions[0]!.label, "qa");
});

// ----------------------------- amendments ----------------------------------

test("an amendment merges into the original run instead of duplicating it", () => {
  const path = recordRun(dir, "qa", "raw output", { kind: "propose", agent: "qa" });
  amendRun(dir, path!.split("/").pop()!, { created: ["ENG-7", "ENG-8"] });

  const records = readRunIndex(dir);
  assert.equal(records.length, 1, "one run, not two");
  assert.deepEqual(records[0]!.created, ["ENG-7", "ENG-8"]);
  // Fields the amendment didn't mention survive.
  assert.equal(records[0]!.agent, "qa");
  assert.equal(records[0]!.logPath, path);
});

test("two distinct runs sharing an id are never merged into one", () => {
  // Only an explicit amend flag merges. Inferring it from a repeated id would
  // silently drop one of two real runs.
  appendRunIndex(dir, rec({ id: "same.log", item: "ENG-1" }));
  appendRunIndex(dir, rec({ id: "same.log", item: "ENG-2" }));

  const records = readRunIndex(dir);
  assert.deepEqual(
    records.map((r) => r.item),
    ["ENG-1", "ENG-2"],
  );
});

test("an amendment for a run outside the read window is dropped, not shown bare", () => {
  amendRun(dir, "never-seen.log", { created: ["ENG-1"] });
  assert.deepEqual(readRunIndex(dir), []);
});

test("an amendment does not reorder history", () => {
  const first = recordRun(dir, "qa", "a", { kind: "propose", agent: "qa" });
  appendRunIndex(dir, rec({ id: "later.log", at: "2099-01-01T00:00:00Z", item: "ENG-9" }));
  amendRun(dir, first!.split("/").pop()!, { created: ["ENG-1"] });

  const sessions = readSessions(dir);
  // The amended proposal must NOT jump ahead of the newer run.
  assert.equal(sessions[0]!.key, "ENG-9");
});

// ----------------------------- highlights ----------------------------------

test("highlights surface a PR, filed tickets and a failure reason", () => {
  const [pr] = toSessions([rec({ item: "ENG-1", prUrl: "https://pr/1" })]);
  assert.deepEqual(highlights(pr!), [{ kind: "pr", text: "https://pr/1" }]);

  const [filed] = toSessions([rec({ id: "p.log", kind: "propose", created: ["ENG-2", "ENG-3"] })]);
  assert.deepEqual(highlights(filed!), [{ kind: "created", text: "filed ENG-2, ENG-3" }]);

  const [failed] = toSessions([
    rec({ item: "ENG-4", kind: "verify", outcome: "failed", reason: "npm test\n2 failed, 41 passed" }),
  ]);
  assert.deepEqual(highlights(failed!), [{ kind: "error", text: "verify: 2 failed, 41 passed" }]);
});

test("a refused gate reads as rejected, not as an error", () => {
  const [s] = toSessions([
    rec({
      item: "ENG-3",
      kind: "verify",
      outcome: "rejected",
      reason: "touched protected paths: src/config/schema.ts",
    }),
  ]);
  assert.match(highlights(s!)[0]!.text, /^rejected: /);
});

test("a thrown Error is not labelled 'error: Error: …'", () => {
  const [s] = toSessions([
    rec({ item: "ENG-4", outcome: "failed", reason: "Error: push rejected — non-fast-forward" }),
  ]);
  assert.equal(highlights(s!)[0]!.text, "error: push rejected — non-fast-forward");
});

test("highlights put the failure first, then what was produced", () => {
  const [s] = toSessions([
    rec({ item: "ENG-5", at: "2026-07-28T10:00:00Z", prUrl: "https://pr/5" }),
    rec({ item: "ENG-5", at: "2026-07-28T10:05:00Z", kind: "verify", outcome: "failed", reason: "boom" }),
  ]);
  const lines = highlights(s!);
  assert.equal(lines[0]!.kind, "error", "trouble reads first");
  assert.equal(lines[1]!.kind, "pr");
});

test("a session with nothing to report still says what ran", () => {
  const [s] = toSessions([
    rec({ item: "ENG-6", kind: "implement" }),
    rec({ item: "ENG-6", kind: "verify" }),
  ]);
  assert.deepEqual(highlights(s!), [{ kind: "info", text: "implement → verify" }]);
});

test("the newest failure wins when a retry fails differently", () => {
  const [s] = toSessions([
    rec({ item: "ENG-7", at: "2026-07-28T10:00:00Z", kind: "verify", outcome: "failed", reason: "first failure" }),
    rec({ item: "ENG-7", at: "2026-07-28T10:30:00Z", kind: "verify", outcome: "failed", reason: "second failure" }),
  ]);
  assert.match(highlights(s!)[0]!.text, /second failure/);
});

test("reasons are trimmed on the way in, keeping the tail", () => {
  const long = `${"x".repeat(5000)}\nFAIL: the useful bit`;
  const trimmed = trimReason(long);
  assert.ok(trimmed.length < 700, `expected a bounded reason, got ${trimmed.length}`);
  assert.match(trimmed, /FAIL: the useful bit$/, "the tail is what matters");
});

// ----------------------------- pruning -------------------------------------

test("pruneRunLogs keeps the newest N and reports what it removed", () => {
  const runs = join(dir, "logs", "runs");
  mkdirSync(runs, { recursive: true });
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(runs, `2026-07-28T10-0${i}-00-000Z-agent.log`), "x");
  }

  const removed = pruneRunLogs(dir, 4);
  assert.equal(removed, 6);
  const left = readdirSync(runs).sort();
  assert.equal(left.length, 4);
  // Names sort by time, so the survivors must be the newest.
  assert.equal(left[0], "2026-07-28T10-06-00-000Z-agent.log");
  assert.equal(left.at(-1), "2026-07-28T10-09-00-000Z-agent.log");
});

test("pruneRunLogs only ever deletes files it wrote", () => {
  const runs = join(dir, "logs", "runs");
  mkdirSync(runs, { recursive: true });
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(runs, `2026-07-28T10-0${i}-00-000Z-agent.log`), "x");
  }
  writeFileSync(join(runs, "notes.md"), "a human parked this here");
  writeFileSync(join(runs, "important.log"), "not our naming scheme");

  pruneRunLogs(dir, 0);
  const left = readdirSync(runs).sort();
  assert.deepEqual(left, ["important.log", "notes.md"]);
});

test("pruning is a no-op below the cap and without a directory", () => {
  assert.equal(pruneRunLogs(dir, 10), 0);
  recordRun(dir, "a", "out", { kind: "propose", agent: "qa" });
  assert.equal(pruneRunLogs(dir, 10), 0);
});
