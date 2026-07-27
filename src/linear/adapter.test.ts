import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearAdapter } from "./adapter.js";
import type { CrewConfig, Proposal } from "../types.js";

/**
 * These exercise createIssue's label assembly against a fake Linear client.
 * Linear rejects the whole mutation when labelIds repeats an id, so the dedupe
 * is load-bearing: without it an agent with a colliding `label` option fails
 * every create it attempts, silently discarding a completed run's findings.
 */

const cfg = {
  linear: {
    labels: { prd: "type:prd", bug: "type:bug", task: "type:task", chore: "type:chore-dx" },
    statuses: { backlog: "Backlog", needsApproval: "Needs Approval" },
  },
} as unknown as CrewConfig;

/** Fake client: records the labelIds passed to createIssue. */
function fakeAdapter(opts: { caseInsensitive?: boolean } = {}) {
  const captured: { labelIds?: string[] } = {};
  const ids = new Map<string, string>();
  const key = (n: string) => (opts.caseInsensitive ? n.toLowerCase() : n);

  const adapter = new LinearAdapter("key", cfg) as unknown as {
    meta: unknown;
    client: unknown;
    stateIdOrThrow: (n: string) => string;
    toWorkItem: (i: unknown) => unknown;
    createIssue: LinearAdapter["createIssue"];
  };

  adapter.meta = { teamId: "T", myUserId: "U", labelIds: {}, stateIds: {} };
  adapter.stateIdOrThrow = () => "state-1";
  adapter.toWorkItem = () => ({ id: "i1", identifier: "ABC-1", labels: [] });
  adapter.client = {
    createIssueLabel: async ({ name }: { name: string }) => {
      const k = key(name);
      if (!ids.has(k)) ids.set(k, `lbl-${ids.size + 1}`);
      return { issueLabel: Promise.resolve({ id: ids.get(k) }) };
    },
    createIssue: async (input: { labelIds?: string[] }) => {
      captured.labelIds = input.labelIds;
      return { issue: Promise.resolve({ id: "i1" }) };
    },
  };
  return { adapter, captured };
}

const proposal: Proposal = { type: "bug", title: "t", body: "b", isMaterial: false };

test("createIssue sends unique labelIds for a normal proposal", async () => {
  const { adapter, captured } = fakeAdapter();
  await adapter.createIssue(proposal, { author: "qa" });
  const ids = captured.labelIds ?? [];
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 3); // type:bug, agent-authored, agent:qa
});

test("an agent label that collides with its own author label is deduped", async () => {
  // The exact failure seen in the wild: agent named "product" with
  // label: "agent:product" — the adapter already adds agent:<author>.
  const { adapter, captured } = fakeAdapter();
  await adapter.createIssue(proposal, { author: "product", label: "agent:product" });
  const ids = captured.labelIds ?? [];
  assert.deepEqual([...new Set(ids)], ids, "labelIds must not repeat");
  assert.equal(ids.length, 3);
});

test("an agent label that collides with the type label is deduped", async () => {
  const { adapter, captured } = fakeAdapter();
  await adapter.createIssue(proposal, { author: "qa", label: "type:bug" });
  const ids = captured.labelIds ?? [];
  assert.deepEqual([...new Set(ids)], ids);
  assert.equal(ids.length, 3);
});

test("a case-variant agent label resolving to the same id is deduped", async () => {
  const { adapter, captured } = fakeAdapter({ caseInsensitive: true });
  await adapter.createIssue(proposal, { author: "product", label: "Agent:Product" });
  const ids = captured.labelIds ?? [];
  assert.deepEqual([...new Set(ids)], ids);
  assert.equal(ids.length, 3);
});

test("a distinct agent label is kept alongside the defaults", async () => {
  const { adapter, captured } = fakeAdapter();
  await adapter.createIssue(proposal, { author: "product", label: "area:growth" });
  assert.equal((captured.labelIds ?? []).length, 4);
});

test("complexity adds one more unique label", async () => {
  const { adapter, captured } = fakeAdapter();
  await adapter.createIssue(
    { ...proposal, complexity: "high" },
    { author: "qa", label: "area:growth" },
  );
  const ids = captured.labelIds ?? [];
  assert.deepEqual([...new Set(ids)], ids);
  assert.equal(ids.length, 5);
});

test("a blank agent label is ignored", async () => {
  const { adapter, captured } = fakeAdapter();
  await adapter.createIssue(proposal, { author: "qa", label: "   " });
  assert.equal((captured.labelIds ?? []).length, 3);
});
