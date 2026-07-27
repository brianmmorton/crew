import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReview, enforceLimits } from "./cycles.js";
import type {
  AgentDef,
  CrewConfig,
  Logger,
  Proposal,
  ReviewOutcome,
  WorkItem,
} from "../types.js";
import type { Ports } from "./ports.js";

const silent: Logger = { info() {}, warn() {}, error() {} };

const agent = (extra: Partial<AgentDef> = {}): AgentDef => ({
  name: "custom",
  kind: "proposer",
  prompt: "",
  cadence: "0 9 * * 1",
  builtin: false,
  ...extra,
});

const proposal = (type: Proposal["type"], title: string): Proposal => ({
  type,
  title,
  body: "",
  isMaterial: false,
});

// ----------------------------- enforceLimits -------------------------------

test("enforceLimits passes everything through when unconstrained", () => {
  const ps = [proposal("bug", "a"), proposal("prd", "b")];
  assert.deepEqual(enforceLimits(agent(), ps, silent), ps);
});

test("enforceLimits drops types the agent may not file", () => {
  const ps = [proposal("bug", "a"), proposal("prd", "b"), proposal("task", "c")];
  const kept = enforceLimits(agent({ allowedTypes: ["bug", "task"] }), ps, silent);
  assert.deepEqual(kept.map((p) => p.title), ["a", "c"]);
});

test("enforceLimits caps the number of proposals", () => {
  const ps = [proposal("bug", "a"), proposal("bug", "b"), proposal("bug", "c")];
  const kept = enforceLimits(agent({ maxProposals: 2 }), ps, silent);
  assert.deepEqual(kept.map((p) => p.title), ["a", "b"]);
});

test("enforceLimits filters by type BEFORE applying the cap", () => {
  // If the cap ran first we'd keep [prd, prd] and then drop both, yielding zero.
  const ps = [proposal("prd", "x"), proposal("prd", "y"), proposal("bug", "keep")];
  const kept = enforceLimits(agent({ allowedTypes: ["bug"], maxProposals: 2 }), ps, silent);
  assert.deepEqual(kept.map((p) => p.title), ["keep"]);
});

test("enforceLimits warns when it drops a disallowed type", () => {
  const warnings: string[] = [];
  const logger: Logger = { ...silent, warn: (m) => warnings.push(m) };
  enforceLimits(agent({ allowedTypes: ["bug"] }), [proposal("prd", "x")], logger);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /may not file/);
});

test("enforceLimits warns when it truncates", () => {
  const warnings: string[] = [];
  const logger: Logger = { ...silent, warn: (m) => warnings.push(m) };
  enforceLimits(agent({ maxProposals: 1 }), [proposal("bug", "a"), proposal("bug", "b")], logger);
  assert.match(warnings[0], /maxProposals=1/);
});

test("enforceLimits handles an empty result", () => {
  assert.deepEqual(enforceLimits(agent({ maxProposals: 3 }), [], silent), []);
});

test("an empty allowedTypes list is treated as 'no restriction'", () => {
  const ps = [proposal("prd", "a")];
  assert.deepEqual(enforceLimits(agent({ allowedTypes: [] }), ps, silent), ps);
});

// ----------------------------- applyReview ---------------------------------

interface Recorded {
  prComments: string[];
  issueComments: string[];
  transitions: string[];
}

function reviewPorts(): { ports: Ports; rec: Recorded } {
  const rec: Recorded = { prComments: [], issueComments: [], transitions: [] };
  const ports = {
    git: {
      commentOnPr: async (_url: string, body: string) => {
        rec.prComments.push(body);
      },
    },
    linear: {
      addComment: async (_id: string, body: string) => {
        rec.issueComments.push(body);
      },
      transition: async (_id: string, to: string) => {
        rec.transitions.push(to);
      },
    },
  } as unknown as Ports;
  return { ports, rec };
}

const item = { id: "i1", identifier: "ABC-1", title: "t" } as WorkItem;
const cfg = { linear: { statuses: { ready: "Todo" } } } as unknown as CrewConfig;

async function review(
  def: AgentDef,
  outcome: ReviewOutcome,
  logger: Logger = silent,
): Promise<Recorded> {
  const { ports, rec } = reviewPorts();
  await applyReview(cfg, ports, def, item, "https://pr/1", outcome, logger);
  return rec;
}

test("applyReview posts the PR comment, attributed to the agent", async () => {
  const rec = await review(agent({ name: "sec", kind: "reviewer" }), {
    prComment: "Found an issue.",
  });
  assert.equal(rec.prComments.length, 1);
  assert.match(rec.prComments[0], /\*\*sec\*\* review/);
  assert.match(rec.prComments[0], /Found an issue\./);
});

test("applyReview posts the Linear comment", async () => {
  const rec = await review(agent({ kind: "reviewer" }), { issueComment: "note" });
  assert.equal(rec.issueComments.length, 1);
  assert.match(rec.issueComments[0], /note/);
});

test("applyReview performs a transition that is on the allowlist", async () => {
  const rec = await review(
    agent({ kind: "reviewer", canTransitionTo: ["Todo", "In Review"] }),
    { transitionTo: "Todo" },
  );
  assert.deepEqual(rec.transitions, ["Todo"]);
});

test("applyReview REFUSES a transition that is not on the allowlist", async () => {
  const warnings: string[] = [];
  const logger: Logger = { ...silent, warn: (m) => warnings.push(m) };
  const rec = await review(
    agent({ kind: "reviewer", canTransitionTo: ["Todo"] }),
    { transitionTo: "Done" },
    logger,
  );
  assert.deepEqual(rec.transitions, []);
  assert.match(warnings[0], /refused transition to "Done"/);
});

test("a reviewer with no allowlist cannot move anything", async () => {
  const rec = await review(agent({ kind: "reviewer" }), { transitionTo: "Done" });
  assert.deepEqual(rec.transitions, []);
});

test("applyReview does nothing for an empty verdict", async () => {
  const rec = await review(agent({ kind: "reviewer" }), {});
  assert.deepEqual(rec, { prComments: [], issueComments: [], transitions: [] });
});

test("applyReview ignores whitespace-only comments", async () => {
  const rec = await review(agent({ kind: "reviewer" }), {
    prComment: "   ",
    issueComment: "\n",
  });
  assert.deepEqual(rec.prComments, []);
  assert.deepEqual(rec.issueComments, []);
});

test("moving an item back to the ready state warns about rework", async () => {
  const warnings: string[] = [];
  const logger: Logger = { ...silent, warn: (m) => warnings.push(m) };
  const { ports, rec } = reviewPorts();
  await applyReview(
    { linear: { statuses: { ready: "Todo" } } } as unknown as CrewConfig,
    ports,
    agent({ kind: "reviewer", canTransitionTo: ["Todo"] }),
    item,
    "https://pr/1",
    { transitionTo: "Todo" },
    logger,
  );
  assert.deepEqual(rec.transitions, ["Todo"]);
  assert.ok(warnings.some((w) => /will be reworked/.test(w)));
});

test("moving an item to a non-ready state does not warn about rework", async () => {
  const warnings: string[] = [];
  const logger: Logger = { ...silent, warn: (m) => warnings.push(m) };
  const { ports } = reviewPorts();
  await applyReview(
    { linear: { statuses: { ready: "Todo" } } } as unknown as CrewConfig,
    ports,
    agent({ kind: "reviewer", canTransitionTo: ["Blocked"] }),
    item,
    "https://pr/1",
    { transitionTo: "Blocked" },
    logger,
  );
  assert.deepEqual(warnings, []);
});

test("a failing PR comment does not prevent the transition", async () => {
  const rec: Recorded = { prComments: [], issueComments: [], transitions: [] };
  const ports = {
    git: {
      commentOnPr: async () => {
        throw new Error("gh exploded");
      },
    },
    linear: {
      addComment: async (_id: string, b: string) => {
        rec.issueComments.push(b);
      },
      transition: async (_id: string, to: string) => {
        rec.transitions.push(to);
      },
    },
  } as unknown as Ports;

  await applyReview(
    cfg,
    ports,
    agent({ kind: "reviewer", canTransitionTo: ["Todo"] }),
    item,
    "https://pr/1",
    { prComment: "x", transitionTo: "Todo" },
    silent,
  );
  assert.deepEqual(rec.transitions, ["Todo"]);
});
