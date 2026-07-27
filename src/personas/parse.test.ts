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

/**
 * Regression: a real product-agent run filed nothing because its prose analysis
 * mentioned `|| []` before the payload. Scanning for the FIRST bracket matched
 * that empty array, which parses cleanly — so the run looked successful while
 * silently discarding every proposal. Prose containing code is normal agent
 * output, so these pin the payload-seeking behaviour.
 */
test("prose containing `|| []` before the payload does not eat the proposals", () => {
  const text =
    "The crash is that `state?.features` is undefined and `|| []` catches it.\n\n" +
    '```json\n{"summary":"s","proposals":[{"type":"bug","title":"real"}]}\n```';
  const parsed = extractProposalsJson(text) as { proposals: Array<{ title: string }> };
  assert.equal(parsed.proposals.length, 1);
  assert.equal(parsed.proposals[0].title, "real");
});

test("an inline `{...}` snippet in prose does not shadow the real payload", () => {
  const text =
    "The handler returns rows shaped `{id, feature: {id}}` which is wrong.\n\n" +
    '```json\n{"proposals":[{"type":"task","title":"fix shape"}]}\n```';
  const parsed = extractProposalsJson(text) as { proposals: Array<{ title: string }> };
  assert.equal(parsed.proposals[0].title, "fix shape");
});

test("when an agent shows an example block first, the final block wins", () => {
  const text =
    "I was asked for this shape:\n```json\n{\"proposals\":[]}\n```\n" +
    "Here is my actual output:\n" +
    '```json\n{"proposals":[{"type":"bug","title":"actual"}]}\n```';
  const parsed = extractProposalsJson(text) as { proposals: Array<{ title: string }> };
  assert.equal(parsed.proposals.length, 1);
  assert.equal(parsed.proposals[0].title, "actual");
});

test("a reviewer verdict is recognized as a payload, not just proposals", () => {
  const text =
    "Looks good overall, though `arr || []` is redundant.\n\n" +
    '```json\n{"verdict":"approve","prComment":"LGTM"}\n```';
  const parsed = extractProposalsJson(text) as Record<string, unknown>;
  assert.equal(parsed.verdict, "approve");
  assert.equal(parsed.prComment, "LGTM");
});

test("a bare JSON reply with no fences or prose still parses", () => {
  const parsed = extractProposalsJson('{"proposals":[{"type":"bug","title":"bare"}]}') as {
    proposals: Array<{ title: string }>;
  };
  assert.equal(parsed.proposals[0].title, "bare");
});

test("a genuinely empty proposals payload is preserved, not treated as a miss", () => {
  // "I found nothing" is a real, meaningful answer — it must not fall through
  // to some earlier bracket in the prose.
  const text = 'Checked `foo || []` everywhere; all clean.\n```json\n{"proposals":[]}\n```';
  const parsed = extractProposalsJson(text) as { proposals: unknown[] };
  assert.deepEqual(parsed.proposals, []);
});

test("output with no JSON at all returns null", () => {
  assert.equal(extractProposalsJson("I could not complete the analysis."), null);
});
