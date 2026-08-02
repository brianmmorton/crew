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
    tracker: {
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
const cfg = { tracker: { statuses: { ready: "Todo" } } } as unknown as CrewConfig;

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
    { tracker: { statuses: { ready: "Todo" } } } as unknown as CrewConfig,
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
    { tracker: { statuses: { ready: "Todo" } } } as unknown as CrewConfig,
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
    tracker: {
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

// ----------------------------- proposerCycle --------------------------------
// Focused on the read-only guardrails: the write tools are stripped from the
// run, and a run that COMMITS to the checkout is a loud failure, never a
// quiet success. The fakes are minimal casts, like the applyReview ones.

import { proposerCycle } from "./cycles.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function proposerFixture(opts: {
  strayCommits?: string[];
  strayDirty?: string[];
  proposals?: Proposal[];
}) {
  const rec = {
    created: [] as string[],
    disallowedTools: undefined as string[] | undefined,
  };
  const def = agent({ name: "migrator" });
  const pcfg = {
    configDir: mkdtempSync(join(tmpdir(), "crew-cycles-")),
    repo: { path: "/repo" },
    triager: { backlogCap: 30 },
    gates: { wipCap: 3 },
    models: { byComplexity: {} },
    tracker: { statuses: { ready: "Todo" }, autoPromote: false },
  } as unknown as CrewConfig;
  const ports = {
    agents: { migrator: def },
    constitution: "",
    tracker: {
      countBacklog: async () => 0,
      countInProgress: async () => 0,
      findSimilarOpen: async () => [],
      createIssue: async (p: Proposal) => {
        rec.created.push(p.title);
        return { id: "1", identifier: `IT-${rec.created.length}` } as unknown as WorkItem;
      },
      assign: async () => {},
      transition: async () => {},
    },
    git: {
      checkoutSnapshot: async () => ({ head: "abc", dirty: [] }),
      strayWork: async () => ({
        commits: opts.strayCommits ?? [],
        dirtyFiles: opts.strayDirty ?? [],
      }),
    },
    persona: {
      run: async (_n: string, o: { disallowedTools?: string[] }) => {
        rec.disallowedTools = o.disallowedTools;
        return { proposals: opts.proposals ?? [] };
      },
    },
  } as unknown as Ports;
  return { rec, def, pcfg, ports };
}

test("proposerCycle strips the write tools from the agent run", async () => {
  const { rec, def, pcfg, ports } = proposerFixture({});
  await proposerCycle(pcfg, ports, def, silent);
  assert.ok(rec.disallowedTools?.includes("Edit"));
  assert.ok(rec.disallowedTools?.includes("Write"));
});

test("a clean run files its proposals", async () => {
  const { rec, def, pcfg, ports } = proposerFixture({
    proposals: [proposal("task", "migrate a")],
  });
  const out = await proposerCycle(pcfg, ports, def, silent);
  assert.equal(out.status, "proposed");
  assert.deepEqual(rec.created, ["migrate a"]);
});

test("commits during a read-only run fail the cycle and file NOTHING", async () => {
  const { rec, def, pcfg, ports } = proposerFixture({
    strayCommits: ["abc123 refactor: did the whole migration"],
    proposals: [proposal("task", "migrate a")],
  });
  const errors: string[] = [];
  const logger: Logger = { ...silent, error: (m) => errors.push(m) };
  const out = await proposerCycle(pcfg, ports, def, logger);
  assert.equal(out.status, "error");
  assert.deepEqual(rec.created, []); // the board never hears about a poisoned run
  assert.ok(errors.some((m) => /COMMITTED/.test(m)));
});

test("dirty files alone warn but keep the proposals — it may be the user typing", async () => {
  const { rec, def, pcfg, ports } = proposerFixture({
    strayDirty: ["src/app.ts"],
    proposals: [proposal("task", "migrate a")],
  });
  const warnings: string[] = [];
  const logger: Logger = { ...silent, warn: (m) => warnings.push(m) };
  const out = await proposerCycle(pcfg, ports, def, logger);
  assert.equal(out.status, "proposed");
  assert.deepEqual(rec.created, ["migrate a"]);
  assert.ok(warnings.some((m) => /src\/app.ts/.test(m)));
});

test("a git port without snapshot support still proposes (guardrail degrades open)", async () => {
  const { rec, def, pcfg, ports } = proposerFixture({
    proposals: [proposal("task", "migrate a")],
  });
  (ports as unknown as { git: object }).git = {}; // no checkoutSnapshot/strayWork
  const out = await proposerCycle(pcfg, ports, def, silent);
  assert.equal(out.status, "proposed");
  assert.deepEqual(rec.created, ["migrate a"]);
});
