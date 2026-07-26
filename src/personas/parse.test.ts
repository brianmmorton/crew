import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClaudeStdout,
  detectUsageLimit,
  extractProposalsJson,
} from "./parse.js";

test("parseClaudeStdout reads a well-formed result object", () => {
  const r = parseClaudeStdout(
    '{"result":"hi","is_error":false,"session_id":"s"}',
  );
  assert.equal(r.resultText, "hi");
  assert.equal(r.isError, false);
  assert.equal(r.sessionId, "s");
});

test("parseClaudeStdout falls back to raw text on non-JSON", () => {
  const r = parseClaudeStdout("not json at all");
  assert.equal(r.resultText, "not json at all");
  assert.equal(r.isError, false);
  assert.equal(r.sessionId, undefined);
});

test("detectUsageLimit flags a session-limit message", () => {
  const r = detectUsageLimit("You've hit your session limit · resets 3:45pm");
  assert.equal(r.limited, true);
  assert.equal(r.resetAt, "3:45pm");
});

test("detectUsageLimit ignores normal text", () => {
  const r = detectUsageLimit("Committed the fix and pushed the branch.");
  assert.equal(r.limited, false);
  assert.equal(r.resetAt, null);
});

test("extractProposalsJson pulls an array out of a fenced block", () => {
  const text =
    'Here are the proposals:\n```json\n[ {"type":"bug","title":"x"} ]\n```\nThanks!';
  const parsed = extractProposalsJson(text) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, "x");
});
