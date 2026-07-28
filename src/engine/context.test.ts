import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImplementerPrompt } from "./context.js";
import type { CrewConfig, WorkItem } from "../types.js";

/**
 * The implementer prompt is the only thing keeping an agent inside its
 * worktree: headless runs use --dangerously-skip-permissions, so there is no
 * sandbox to fall back on. These lock in the instructions that matter.
 */

const cfg = {
  repo: { path: "/main/checkout", baseBranch: "main" },
  gates: { noTouch: ["**/*.env"] },
} as unknown as CrewConfig;

const item = {
  id: "i1",
  identifier: "ABC-1",
  title: "Do the thing",
  description: "details",
} as WorkItem;

const WT = "/main/.crew-worktrees-checkout/agent-abc-1";

test("the prompt states the worktree path the agent must work in", () => {
  const p = buildImplementerPrompt(cfg, "persona", "constitution", item, WT);
  assert.ok(p.includes(WT), "the absolute worktree path must appear in the prompt");
});

test("the prompt forbids cd-ing to the main checkout by name", () => {
  const p = buildImplementerPrompt(cfg, "persona", "constitution", item, WT);
  assert.match(p, /Never `cd` to \/main\/checkout/);
});

test("the prompt overrides absolute paths found in AGENTS.md", () => {
  const p = buildImplementerPrompt(cfg, "persona", "constitution", item, WT);
  // AGENTS.md in a monorepo commonly hardcodes a developer's own checkout path;
  // following it is exactly how an agent ends up committing in the wrong repo.
  assert.match(p, /AGENTS\.md[\s\S]*names an absolute path, IGNORE that/);
});

test("the AGENTS.md instruction no longer tells the agent to follow it for paths", () => {
  const p = buildImplementerPrompt(cfg, "persona", "constitution", item, WT);
  assert.match(p, /but NOT for directory paths/);
});

test("omitting the worktree keeps the prompt valid for callers that have none", () => {
  const p = buildImplementerPrompt(cfg, "persona", "constitution", item);
  assert.ok(p.includes("Do the thing"), "still a usable prompt");
  assert.ok(!p.includes("# Where you are working"), "no empty location section");
});

test("the task and constitution still make it into the prompt", () => {
  const p = buildImplementerPrompt(cfg, "persona-text", "the-constitution", item, WT);
  for (const needle of ["persona-text", "the-constitution", "ABC-1", "details", "**/*.env"]) {
    assert.ok(p.includes(needle), `prompt is missing ${needle}`);
  }
});
